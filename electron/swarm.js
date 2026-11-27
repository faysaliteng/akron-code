'use strict';
// Supervisor-led multi-agent swarm with complexity-based model routing.
//
// This is the local equivalent of what the Example app/Claude Code do when a
// task is big enough to need a team: a *lead* model (the supervisor) reads the
// goal, splits it into independent subtasks, tags each subtask with a
// complexity tier, the host routes every subtask to the model tier that fits it
// (small/cheap for mechanical work, frontier for heavy or critical work), the
// subtasks run concurrently on *different* models, and finally the supervisor
// reviews the results and merges them into one answer.
//
// Nothing here imports llm.js. The caller injects `runAgent`, which keeps this
// module pure and testable, and avoids a require cycle.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const TIER_RANK = { small: 0, heavy: 1, critical: 2 };
const router = require('./orch-router');
const gate = require('./provider-gate');
const usageEstimator = require('./usage-estimator');
const modeCollab = require('./mode-collab');

function ensureHighThinkingSupervisor(sup, roster = []) {
  if (!sup || typeof sup !== 'object') return sup;
  let picked = { ...sup };
  const curModel = String(picked.model || '').trim();
  // Prefer the matching `-high` variant over `-low` or `-medium` on the same provider/tier when present.
  if (curModel && /-(?:low|medium)$/i.test(curModel) && Array.isArray(roster) && roster.length) {
    const highSlug = curModel.replace(/-(?:low|medium)$/i, '-high');
    const match = roster.find((r) => r && String(r.model || '').trim().toLowerCase() === highSlug.toLowerCase());
    if (match) picked = { ...match, tier: 'critical' };
    else if (String(picked.oauthProvider || '').toLowerCase().startsWith('antigravity')) picked.model = highSlug;
  }
  if (!picked._disableThinking) picked.reasoningLevel = 'high';
  picked.tier = 'critical';
  return picked;
}

// The supervisor plans and reviews; it must not start building during planning.
// During review it may run commands and repair integration defects / missing pieces.
const PLAN_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'ListDir', 'TodoWrite']);
const READONLY_REVIEW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'ListDir', 'Bash', 'TodoWrite']);
const REVIEW_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'ListDir', 'Bash', 'TodoWrite']);
const MAX_CONCURRENCY = 8;
const MAX_ROUNDS_PER_MEMBER = 3;
const MAX_DYNAMIC_WORKERS = 6;

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
const FRONTIER_RE = /(kimi|moonshot|deepseek|glm|zhipu|chatgpt|gpt-?[3-9]|codex|\bo[1-4]\b|anthropic|claude|fable|sonnet|opus|gemini[- ]?(pro|ultra|3|4|5|6|7|8|9|2\.5-pro)|carbon|neon|hydrogen|argon|qwen.*(max|235b)|grok|command-r-plus|mistral-large|frontier|terra|luna|reserve)/i;
const SMALL_OR_FAST_RE = /(?:^|[-_/.:\s])(haiku|mini|nano|lite|small|spark|instant)(?=$|[-_/.:\s])|gemini[- ]?(?:1|2(?:\.[05])?)-flash|flash-worker|grok-[0-9.]+-fast/i;
function inferModelTier(model, fallback) {
  const m = String(model || '').toLowerCase();
  if (!m) return fallback || 'heavy';
  if (/(haiku|hydrogen-low|neon-low|sonnet-[0-9.-]+-low|flash-worker|gemini-2\.5-flash|grok-4-fast|gpt-5\.6-luna|flash|(?:^|[-_/.])mini(?=$|[-_/.])|nano|lite|small|\b[1-9]b\b)/i.test(m)) return 'small';
  if (/(opus(?!.*-low)|ultra|carbon-high|neon-high|neon-xhigh|hydrogen-xhigh|fable|grok-4\.5|\bo3\b|\bgpt-6\b|pro-max|reasoner|orchestrator)/i.test(m)) return 'critical';
  return fallback || 'heavy';
}

function isSmallParamModel(modelId) {
  return /\b([1-9]|[12][0-9]|3[0-5])b\b/i.test(String(modelId || ''));
}

function isFrontier(p) {
  if (!p) return false;
  if (p.frontier === true) return true;
  if (p.frontier === false) return false;
  const base = String(p.baseURL || '');
  const modelStr = String(p.model || '').trim();
  const isFreeLlm = /:(3001|31415)\b/.test(base);
  if (isSmallParamModel(modelStr)) return false;
  if (SMALL_OR_FAST_RE.test(modelStr)) return false;
  const s = isFreeLlm ? modelStr : [modelStr, p.name].filter(Boolean).join(' ');
  return FRONTIER_RE.test(s);
}

// Build the pool of models the swarm may use. The orchestrator's provider list
// is the pool; each entry may carry a `tier` (set in Settings). The currently
// selected provider is always present so a swarm still works with the
// orchestrator disabled — it simply runs every subtask on one model.
//
// An entry is either a gateway row (`baseURL` + optional `apiKey`) or a
// subscription row (`oauthProvider` = "<provider>:<account>"); the latter has
// no baseURL because main mints the bearer token and picks the endpoint at
// turn time, so the guard below must admit it or every signed-in model would
// silently vanish from the roster.
function rosterSourcePriority(p) {
  if (!p) return 3;
  if (p.oauthProvider || p.oauth || p.accessToken) return 0;
  const base = String(p.baseURL || '').trim();
  const key = String(p.apiKey || '').trim();
  if (/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return 2;
  if (/:11434\b/i.test(base)) return 3;
  if (key) return 1;
  return 3;
}

function buildRoster(opts = {}) {
  const { orchestrator, provider, frontierOnly } = opts;
  const roster = [];
  const seen = new Set();
  const add = (p, fallbackTier, role) => {
    if (!p || p.enabled === false) return;
    const isOauth = !!p.oauthProvider || !!p.oauth || !!p.accessToken;
    const base = String(p.baseURL || '').trim();
    const apiKey = String(p.apiKey || '').trim();
    if (!base && !isOauth) return;
    if (!isOauth && !router.isGatewayCredentialReady(base, apiKey)) return;
    const key = isOauth
      ? 'oauth|' + p.oauthProvider + '|' + String(p.model || '')
      : base + '|' + String(p.model || '');
    if (seen.has(key)) return;
    seen.add(key);
    const inferredTier = inferModelTier(p.model || p.name, fallbackTier);
    // When a model is clearly a small/fast variant (e.g. haiku / flash / mini / nano),
    // prefer its inferred 'small' tier over a generic default 'heavy' tag from auto-import.
    const rawTier = p.tier ? normalizeTier(p.tier, inferredTier) : inferredTier;
    const effectiveTier = (rawTier === 'heavy' && inferredTier === 'small') ? 'small' : rawTier;
    roster.push({
      id: p.id || key,
      name: p.name || p.model || 'model',
      baseURL: base,
      apiKey: p.apiKey || '',
      model: p.model || '',
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      reasoningLevel: p.reasoningLevel,
      supportsTools: p.supportsTools !== false,
      // Subscription rows resolve their credential in main, so carry the
      // binding through instead of rewriting it as an anonymous endpoint.
      oauthProvider: p.oauthProvider || '',
      transport: p.transport || '',
      oauth: !!p.oauth || isOauth,
      accessToken: p.accessToken || '',
      account: p.account || '',
      accountId: p.accountId || '',
      sessionId: p.sessionId || '',
      codexUrl: p.codexUrl || '',
      cloudcodeUrl: p.cloudcodeUrl || '',
      project: p.project || '',
      gateKey: p.gateKey || '',
      maxConcurrent: Number(p.maxConcurrent) > 0 ? Number(p.maxConcurrent) : undefined,
      contextWindow: Number(p.contextWindow) || 0,
      frontier: isFrontier(p),
      tier: effectiveTier,
      jobRole: router.normalizeRole(p.jobRole || p.role) || null,
      role,
    });
  };

  const provs = (orchestrator && Array.isArray(orchestrator.providers)) ? orchestrator.providers : [];
  provs.forEach((p, i) => add(p, 'heavy', orchestrator && orchestrator.activeIndex === i ? 'active' : 'pool'));
  // The active provider is last but tagged critical when it is the only model,
  // so a single-model setup still gets sensible routing.
  if (provider) add(provider, roster.length ? 'heavy' : 'critical', 'active');

  // Keep Paid Subscriptions & Keyed Frontier ahead of FreeLLMAPI pools & Ollama
  // while preserving relative order inside the same priority tier.
  const ordered = roster.map((r, idx) => ({ r, idx, prio: rosterSourcePriority(r) }))
    .sort((a, b) => (a.prio - b.prio) || (a.idx - b.idx))
    .map((x) => x.r);
  roster.length = 0;
  roster.push(...ordered);

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
// models for heavy/critical work. Supports idle-first de-confliction when opts
// provides `busyModels` or `isBusy`.
function pickProvider(roster, tier, index, opts = {}) {
  if (!roster || !roster.length) return null;
  const want = normalizeTier(tier);
  const idx = Math.max(0, Number(index) || 0);
  const busySet = opts && opts.busyModels instanceof Set
    ? new Set([...opts.busyModels].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const isBusyFn = opts && typeof opts.isBusy === 'function' ? opts.isBusy : null;
  const checkDeconflict = Boolean(busySet || isBusyFn);
  const isHealthy = (r) => r && (!gate || typeof gate.usable !== 'function' || gate.usable(r));
  const isBusy = (r) => {
    if (!r) return false;
    if (!isHealthy(r)) return true;
    if (busySet && busySet.has(String(r.model || '').trim().toLowerCase())) return true;
    if (isBusyFn && isBusyFn(r)) return true;
    return false;
  };

  if (checkDeconflict) {
    const tierOrder = want === 'small'
      ? ['small', 'heavy', 'critical']
      : (want === 'critical' ? ['critical', 'heavy', 'small'] : ['heavy', 'critical', 'small']);
    for (const t of tierOrder) {
      const idleExact = roster.filter((r) => r.tier === t && !isBusy(r));
      if (idleExact.length) return idleExact[idx % idleExact.length];
    }
    const anyIdle = roster.filter((r) => !isBusy(r));
    if (anyIdle.length) return anyIdle[idx % anyIdle.length];
  }

  // Several rows of the same tier: spread parallel workers across them
  // (worker i gets row i mod n) instead of piling every worker onto the first.
  const healthyPool = roster.filter(isHealthy);
  const pool = healthyPool.length ? healthyPool : roster;
  const exacts = pool.filter((r) => r.tier === want);
  if (exacts.length) return exacts[idx % exacts.length];
  const rank = TIER_RANK[want];
  const sorted = [...pool].sort((a, b) => {
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
    const prompt = t.prompt || t.instructions || t.task || t.brief || t.goal || t.objective || t.description || '';
    const title = t.title || t.name || t.label || t.id || t.description || prompt;
    if (!String(prompt || title).trim()) return;
    tasks.push({
      id: String(t.id || 't' + (i + 1)),
      title: String(title || '').slice(0, 120),
      prompt: String(prompt || title),
      tier: normalizeTier(t.tier || t.complexity || t.model_tier, 'heavy'),
      role: router.normalizeRole(t.role || t.job) || null,
      model: t.model ? String(t.model) : null,
      owns: Array.isArray(t.owns) ? t.owns.map(String).slice(0, 20) : [],
      isolation: t.isolation === 'worktree' ? 'worktree' : null,
      worktree: Boolean(t.worktree || t.isolation === 'worktree'),
    });
  });
  if (!tasks.length) return null;
  return {
    subtasks: tasks,
    threads: modeCollab.normalizeThreads(raw, tasks),
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
- If USER GOAL already specifies explicit numbered/named subtasks, questions, or deliverables, preserve those EXACT subtasks 1-for-1 (do NOT replace or drop them for generic tasks).
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
{"subtasks":[{"id":"t1","title":"short label","tier":"small|heavy|critical","role":"coder|vision|fast|planner","prompt":"complete instructions for that agent","owns":["path/or/area"]}],"synthesis":"how to merge the results"}
("role" is optional: coder = implementation (default), vision = UI/screenshot work,
fast = trivial/mechanical, planner = architecture/review.)

USER GOAL:
{GOAL}`;

const SUPERVISOR_MERGE_PROMPT = `You are the SUPERVISOR (lead) of a multi-agent team that has just
finished its subtasks. Inspect the created files, run real build/syntax/smoke verification
checks with Bash, fix any broken imports, missing glue code, or failed subtask gaps with
Write/Edit/MultiEdit, and produce the complete verified answer for the user. Rules:
- Actively verify on disk (Read/Glob/Bash) before claiming anything works.
- If a worker subtask failed or left a cross-file integration bug, repair it yourself now.
- Call out anything that genuinely cannot run cleanly (e.g. missing external paid credentials).
- State exact created file paths, how to start/test it, and verified test output.
{FILES}
SUBTASK RESULTS:
{RESULTS}`;

function workerPrompt(goal, task, board) {
  const owns = Array.isArray(task.owns) && task.owns.length
    ? `\nYou own these files/areas: ${task.owns.join(', ')}. Do not modify files owned by other agents.`
    : '\nOnly create/modify the files this task needs. Other agents are editing other files concurrently.';
  const bus = board
    ? `\nSWARM BOARD (you are @${board.me}). Your channel is "${board.channel}".
- swarm_post_message({channel,text,to}) posts to the board. Post ONE short
  message when you start (what you are building), and ONE when you finish
  (what files you created + anything another worker must know).
- read_board/swarm_read_board({since}) reads the feed, oldest first. Read it
  once near the start so you do not duplicate another worker's work.
- swarm_wait({since}) sleeps until a new message arrives. Use it only when you
  are blocked on another worker; never poll it in a loop.
- swarm_add_worker({name,title,prompt,role}) spawns a helper worker onto the
  live board for an independent piece of work (it reports back to you).
- swarm_kill_worker({name,reason}) stops a helper you spawned.
- swarm_switch_model({model,role}) switches your model (or a helper's) if needed.
- @name in a message wakes that member. Ask a specific member by name when you
  need a decision, not the whole board.
You are not the supervisor: do not try to manage other agents.`
    : '';
  return `You are one worker on a multi-agent team. Other workers are working on OTHER
parts of the same goal at the same time in the same project folder.
YOUR SUBTASK (${task.tier} tier): ${task.title}
${task.prompt}${owns}${bus}

OVERALL GOAL (context only — do not redo work outside your subtask):
${goal}

Do your subtask now and finish with a short report of what you created/changed.`;
}

// Sent to a worker whose turn ended without posting anything to the board. The
// Antigravity runtime calls this the stall monitor: rather than re-running the
// whole subtask, it re-briefs the member with what the host observed.
const STALL_NOTE = `Your previous turn ended without reporting on the board, so the
supervisor cannot see your progress or hand off to you. Do not restart your work.
Instead: (1) run swarm_read_board({since:0}) to see what the team has done,
(2) run swarm_post_message with a short status — what you created, what is still
missing, and anything another worker needs. If your subtask is already finished,
say so explicitly in the post.`;

// ---------- swarm board ----------
//
// This is the piece that turns "fan out and merge" into the swarm behaviour the
// Antigravity runtime actually runs: a sequence-numbered message board every
// member can post to and read, a `wait` that parks a member until something it
// cares about is posted, @mention routing, and a stall monitor that re-briefs a
// member whose turn ended without moving. Antigravity exposes it to its agents
// as post_message / read_board / swarm_wait / manage_task; we expose the same
// three primitives under a `swarm_` prefix so they cannot collide with the
// built-in tool surface.
//
// Pure data structure + promise plumbing: no provider imports, so the whole
// thing is unit-testable with a fake runAgent.
const BOARD_LIMIT = 4000;

function createBoard(hooks = {}) {
  const onPost = typeof hooks.onPost === 'function' ? hooks.onPost : null;
  const onMember = typeof hooks.onMember === 'function' ? hooks.onMember : null;
  const messages = [];
  const members = new Map();
  let seq = 0;
  let waiters = [];

  const notify = () => {
    const due = waiters;
    waiters = [];
    for (const w of due) w();
  };

  const board = {
    get seq() { return seq; },
    messages,
    post({ from, channel = 'general', text = '', to = null } = {}) {
      const msg = {
        seq: ++seq,
        from: String(from || 'anon'),
        channel: String(channel || 'general'),
        text: String(text || '').slice(0, 8000),
        to: to ? String(to).replace(/^@+/, '') : null,
        at: Date.now(),
      };
      messages.push(msg);
      if (messages.length > BOARD_LIMIT) messages.splice(0, messages.length - BOARD_LIMIT);
      notify();
      if (onPost) { try { onPost({ ...msg }); } catch (_) {} }
      return msg;
    },
    read({ since = 0, channel = null, limit = 200, me = null } = {}) {
      const from = Math.max(0, Number(since) || 0);
      let out = messages.filter((m) => m.seq > from);
      // A channel filter keeps that channel plus messages addressed to the
      // reader — not every directed message meant for someone else.
      if (channel && channel !== '*') out = out.filter((m) => m.channel === channel || (m.to && (!me || m.to === me)));
      return out.slice(0, Math.max(1, Number(limit) || 200));
    },
    // Messages that concern `me`: an explicit `to`, or an @mention in the text.
    addressedTo(me, { since = 0 } = {}) {
      // `(?![\w-])`, not `\b`: @api must not match @api-2.
      const meRe = new RegExp('@' + String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'i');
      return messages.filter((m) => m.seq > (Number(since) || 0)
        && (m.to === me || meRe.test(m.text)));
    },
    setMember(name, patch = {}) {
      const id = String(name || '');
      if (!id) return null;
      const cur = members.get(id) || { name: id, state: 'idle', posts: 0, lastSeq: 0 };
      const before = cur.state + '|' + cur.posts + '|' + cur.model;
      Object.assign(cur, patch, { at: Date.now() });
      members.set(id, cur);
      if (onMember && before !== cur.state + '|' + cur.posts + '|' + cur.model) {
        try { onMember({ name: cur.name, state: cur.state, role: cur.role, tier: cur.tier, model: cur.model, posts: cur.posts || 0 }); } catch (_) {}
      }
      return cur;
    },
    member(name) { return members.get(String(name || '')) || null; },
    status() { return Array.from(members.values()).map((m) => ({ ...m })); },
    transcript({ limit = 120 } = {}) {
      return messages.slice(-Math.max(1, limit)).map((m) => {
        const to = m.to ? ` → @${m.to}` : '';
        return `#${m.seq} ${m.from}${to} [${m.channel}]: ${m.text}`;
      }).join('\n');
    },
    // Park until a message the caller cares about arrives, or the timeout hits.
    wait({ me = null, since = 0, mentionsOnly = false, channel = null, timeoutMs = 30000, signal = null } = {}) {
      const from = Number(since) || 0;
      const mine = () => {
        const fresh = board.read({ since: from, channel: mentionsOnly ? null : channel });
        if (!mentionsOnly) return fresh.length ? fresh : null;
        return me ? (board.addressedTo(me, { since: from }).length ? board.addressedTo(me, { since: from }) : null) : null;
      };
      const hit = mine();
      if (hit) return Promise.resolve({ messages: hit, timedOut: false });
      const budget = Math.max(10, Math.min(Number(timeoutMs) || 30000, 600000));
      return new Promise((resolve) => {
        let done = false;
        const finish = (res) => {
          if (done) return;
          done = true;
          const i = waiters.indexOf(check);
          if (i >= 0) waiters.splice(i, 1);
          clearTimeout(timer);
          if (signal) signal.removeEventListener && signal.removeEventListener('abort', onAbort);
          resolve(res);
        };
        const check = () => {
          const got = mine();
          if (got) finish({ messages: got, timedOut: false });
        };
        const onAbort = () => finish({ messages: [], timedOut: false, aborted: true });
        const timer = setTimeout(() => finish({ messages: [], timedOut: true }), budget);
        if (timer.unref) timer.unref();
        if (signal) {
          if (signal.aborted) return finish({ messages: [], timedOut: false, aborted: true });
          signal.addEventListener && signal.addEventListener('abort', onAbort, { once: true });
        }
        waiters.push(check);
      });
    },
  };
  return board;
}

// Board tool surface for one member. Returned as `extraTools`-shaped entries so
// runAgent can advertise them, plus `localTools` handlers so the executor can
// run them without a new built-in tool name.
function boardTools(board, me, opts = {}) {
  const startSeq = Math.max(0, Number(opts.startAt) || 0);
  let lastSeq = startSeq;
  const tools = [];
  const add = (name, description, inputSchema, run) => {
    tools.push({ name, description, inputSchema, run });
  };

  add('swarm_post_message',
    'Post a message to the swarm board. Every worker sees it. Use `to` (a worker name) or an @mention to address one member.',
    { type: 'object', properties: { channel: { type: 'string', description: 'Board channel, e.g. "general" or your task channel.' }, text: { type: 'string', description: 'The message body.' }, to: { type: 'string', description: 'Optional worker name this message is for.' } }, required: ['text'] },
    (a = {}) => {
      const msg = board.post({ from: me, channel: a.channel || opts.channel || 'general', text: a.text, to: a.to });
      board.setMember(me, { state: 'posted', posts: ((board.member(me) || {}).posts || 0) + 1, lastSeq: msg.seq });
      lastSeq = Math.max(lastSeq, msg.seq);
      return `posted #${msg.seq} (${msg.channel}${msg.to ? ' → ' + msg.to : ''})`;
    });

  add('swarm_read_board',
    'Read the swarm board feed, oldest first. Returns messages newer than `since`. Call once near the start so you do not duplicate another worker.',
    { type: 'object', properties: { since: { type: 'number', description: 'Return messages with seq > since (default 0).' }, channel: { type: 'string', description: 'Optional channel filter.' }, limit: { type: 'number' } } },
    (a = {}) => {
      const list = board.read({ since: a.since == null ? lastSeq : a.since, channel: a.channel || null, limit: a.limit || 200, me });
      if (!list.length) return 'board: no new messages';
      const hi = list[list.length - 1].seq;
      lastSeq = Math.max(lastSeq, hi);
      board.setMember(me, { readSeq: Math.max((board.member(me) || {}).readSeq || 0, hi) });
      return list.map((m) => `#${m.seq} ${m.from}${m.to ? ' → @' + m.to : ''} [${m.channel}]: ${m.text}`).join('\n')
        + `\n(last seq ${hi} — pass since:${hi} next time)`;
    });

  add('swarm_wait',
    'Park until a new board message arrives (or `timeout_ms` elapses). Releases your worker slot while waiting so blocked work never deadlocks.',
    { type: 'object', properties: { since: { type: 'number', description: 'Last seq you have seen.' }, mentions_only: { type: 'boolean', description: 'Only wake for messages addressed to you.' }, timeout_ms: { type: 'number' } } },
    async (a = {}) => {
      const since = a.since == null ? lastSeq : Number(a.since);
      board.setMember(me, { state: 'waiting' });
      // Release the concurrency slot while parked so unstarted or helper
      // workers can run and actually produce the message we are waiting on.
      if (typeof opts.onWaitStart === 'function') { try { await opts.onWaitStart(); } catch (_) {} }
      let res;
      try {
        res = await board.wait({
          me,
          since,
          mentionsOnly: !!a.mentions_only,
          timeoutMs: a.timeout_ms || 20000,
          signal: opts.signal,
        });
      } finally {
        if (typeof opts.onWaitEnd === 'function') { try { await opts.onWaitEnd(); } catch (_) {} }
      }
      board.setMember(me, { state: 'working' });
      if (!res.messages.length) return res.aborted ? 'board: wait aborted' : 'board: no new messages (timeout) — continue your own work';
      const hi = res.messages[res.messages.length - 1].seq;
      lastSeq = Math.max(lastSeq, hi);
      board.setMember(me, { readSeq: Math.max((board.member(me) || {}).readSeq || 0, hi) });
      return res.messages.map((m) => `#${m.seq} ${m.from}${m.to ? ' → @' + m.to : ''} [${m.channel}]: ${m.text}`).join('\n');
    });

  add('swarm_status',
    'List swarm members and their last known state.',
    { type: 'object', properties: {} },
    () => board.status().map((m) => `${m.name}: ${m.state}${m.posts ? ` (${m.posts} posts)` : ''}`).join('\n') || 'board: no members');

  if (typeof opts.onAddWorker === 'function') {
    add('swarm_add_worker',
      'Spawn a helper worker onto this swarm for a sub-piece of work. Posts its brief on the board and runs it concurrently.',
      { type: 'object', properties: { name: { type: 'string', description: 'Short lowercase handle (e.g. helper-tests)' }, title: { type: 'string' }, prompt: { type: 'string' }, role: { type: 'string', description: 'coder | fast | vision | planner' }, tier: { type: 'string', enum: ['small', 'heavy', 'critical'] }, model: { type: 'string' }, owns: { type: 'array', items: { type: 'string' } } }, required: ['prompt'] },
      async (a = {}) => opts.onAddWorker(me, a));
  }
  if (typeof opts.onKillWorker === 'function') {
    add('swarm_kill_worker',
      'Stop a helper worker you added (or any worker if you are supervisor).',
      { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' } }, required: ['name'] },
      async (a = {}) => opts.onKillWorker(me, a));
  }
  if (typeof opts.onSwitchModel === 'function') {
    add('swarm_switch_model',
      'Switch your own model/role (or a helper you added) for subsequent steps/rounds.',
      { type: 'object', properties: { name: { type: 'string', description: 'Member handle (defaults to yourself)' }, model: { type: 'string' }, role: { type: 'string' } } },
      async (a = {}) => opts.onSwitchModel(me, a));
  }

  const byName = new Map(tools.map((t) => [t.name, t.run]));
  return {
    defs: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    localTools: Object.fromEntries(byName),
  };
}

// ---------- runner ----------

// Decompose the goal with the supervisor. Returns { subtasks, synthesis } or null.
async function decompose(opts) {
  const { runAgent, supervisor, roster, goal, emit = () => {}, maxTasks = 6 } = opts;
  if (typeof runAgent !== 'function' || !supervisor) return null;
  const prompt = SUPERVISOR_PLAN_PROMPT
    .replace('{MAX}', String(maxTasks))
    .replace('{ROSTER}', opts.rosterText || rosterSummary(roster))
    .replace('{GOAL}', goal);
  let text = '';
  try {
    const out = await runAgent({
      provider: supervisor,
      orchestrator: opts.supervisorOrch || null,
      messages: [{ role: 'user', content: prompt }],
      maxSteps: 8,
      cwd: opts.cwd,
      signal: opts.signal,
      useMemory: false,
      toolAllow: PLAN_TOOLS,
      emit: (evt) => { if (evt && evt.type === 'done') return; emit({ ...evt, subagent: 'supervisor', role: 'supervisor' }); },
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
  const swarmUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, context_tokens: 0, model: '' };
  const trackedRunAgent = async (agentOpts = {}) => {
    const callerEmit = typeof agentOpts.emit === 'function' ? agentOpts.emit : () => {};
    let memberLastUsage = null;
    const out = await runAgent({
      ...agentOpts,
      emit: (evt) => {
        if (evt && evt.type === 'usage' && evt.usage) memberLastUsage = evt.usage;
        else if (evt && evt.type === 'done' && evt.usage) memberLastUsage = evt.usage;
        callerEmit(evt);
      },
    });
    const lastU = memberLastUsage || (Array.isArray(out) ? ([...out].reverse().find((m) => m && m.usage) || {}).usage : null);
    const normU = usageEstimator.normalizeCallUsage(lastU);
    if (normU) {
      swarmUsage.prompt_tokens += normU.prompt_tokens || 0;
      swarmUsage.completion_tokens += normU.completion_tokens || 0;
      swarmUsage.total_tokens += normU.total_tokens || 0;
      swarmUsage.calls += Number(lastU && lastU.calls) || 1;
      const ctx = Number(lastU && lastU.context_tokens) || normU.prompt_tokens || 0;
      if (ctx > swarmUsage.context_tokens) swarmUsage.context_tokens = ctx;
      if (!swarmUsage.model && (lastU && lastU.model)) swarmUsage.model = lastU.model;
      emit({ type: 'usage', subrun: true, usage: { ...swarmUsage }, model: swarmUsage.model });
    }
    return out;
  };
  // Role pools (FreeLLMAPI layout): supervisor on Planner, workers on Coder
  // (or the role/tier the plan asks for), each with its own downward failover
  // chain. Without pools the swarm keeps the frontier-only roster, but every
  // worker now gets a failover chain too instead of a single pinned model.
  const poolOrch = (opts.poolOrchestrator && router.poolsConfig(opts.poolOrchestrator))
    ? opts.poolOrchestrator
    : (opts.orchestrator && router.poolsActive(opts.orchestrator, opts.provider) ? opts.orchestrator : null);
  const poolBase = opts.provider || null;
  let roster;
  if (poolOrch) {
    const rawPoolRows = [];
    for (const r of router.ROLES) {
      for (const row of router.resolve(poolOrch, r, poolBase)) if (row.role === r) rawPoolRows.push({ ...row, jobRole: r });
    }
    const frontierPoolRows = rawPoolRows.filter((row) => isFrontier(row));
    roster = frontierPoolRows.length ? frontierPoolRows : rawPoolRows;
  } else {
    roster = buildRoster({ orchestrator: opts.orchestrator, provider: opts.provider, frontierOnly: true });
  }

  // Track active swarm worker models so concurrent workers avoid colliding on the same model when idle ones exist.
  const activeSwarmModels = new Set();

  // A failover chain (an orchestrator object runAgent understands) for one job.
  const chainFor = (tier, index, roleHint, model, deconflict = false) => {
    if (poolOrch) {
      const role = router.normalizeRole(roleHint) || router.tierToRole(tier) || 'coder';
      const scoped = router.orchestratorFor(poolOrch, role, poolBase, { index, preferModel: model || undefined });
      if (scoped && Array.isArray(scoped.providers) && scoped.providers.length > 1) {
        const healthy = scoped.providers.filter((p) => gate.usable(p));
        const cooling = scoped.providers.filter((p) => !gate.usable(p));
        if (healthy.length && cooling.length) {
          return { ...scoped, providers: healthy.concat(cooling) };
        }
      }
      return scoped;
    }
    const base = (model && roster.find((r) => r.model === model))
      || (deconflict
        ? pickProvider(roster, tier, index, {
          busyModels: activeSwarmModels,
          isBusy: (r) => activeSwarmModels.has(String(r.model || '').toLowerCase()) || gate.inflight(r) > 0,
        })
        : pickProvider(roster, tier, index));
    if (!base) return null;
    if (deconflict && base.model) activeSwarmModels.add(String(base.model).toLowerCase());
    const rest = roster.filter((r) => r !== base);
    const orderedRest = [
      ...rest.filter((r) => gate.usable(r) && r.tier === base.tier),
      ...rest.filter((r) => gate.usable(r) && r.tier !== base.tier),
      ...rest.filter((r) => !gate.usable(r)),
    ];
    const providers = [base].concat(orderedRest);
    return { enabled: true, providers, activeIndex: 0, role: 'pinned' };
  };

  // Supervisor: an explicit pin wins; otherwise Planner / the strongest tier.
  // Supervisor thinking mode is ALWAYS forced to 'high' (+ `-high` variant when available).
  let supervisorOrch = null;
  let supervisor = null;
  if (opts.supervisor) {
    supervisor = ensureHighThinkingSupervisor({ ...opts.supervisor, tier: 'critical' }, roster);
  } else {
    supervisorOrch = chainFor('critical', 0, 'planner');
    supervisor = supervisorOrch ? ensureHighThinkingSupervisor({ ...supervisorOrch.providers[0], tier: 'critical' }, roster)
      : (opts.provider ? ensureHighThinkingSupervisor({ ...opts.provider, tier: 'critical' }, roster) : null);
  }
  if (!supervisor) throw new Error('swarm has no model to run on (configure a provider or an orchestrator tier)');
  if (supervisorOrch && Array.isArray(supervisorOrch.providers)) {
    supervisorOrch = {
      ...supervisorOrch,
      providers: supervisorOrch.providers.map((p) => ensureHighThinkingSupervisor(p, roster)),
    };
  }
  const keyOf = (r) => (r && r.oauthProvider
    ? 'oauth|' + r.oauthProvider + '|' + String(r.model || '')
    : String((r && r.baseURL) || '') + '|' + String((r && r.model) || ''));
  const supKey = keyOf(supervisor);
  if (!roster.some((r) => keyOf(r) === supKey)) {
    roster.push({ ...supervisor, tier: 'critical', role: 'supervisor' });
  }
  const rosterText = poolOrch ? (router.summary(poolOrch, poolBase) || rosterSummary(roster)) : rosterSummary(roster);

  emit({
    type: 'swarm',
    phase: 'start',
    goal,
    pools: !!poolOrch,
    supervisor: { model: supervisor.model, baseURL: supervisor.baseURL, reasoningLevel: supervisor.reasoningLevel || 'high' },
    roster: roster.map((r) => ({ model: r.model, tier: r.tier, role: r.jobRole || undefined })),
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
      runAgent: trackedRunAgent, supervisor, supervisorOrch, roster, rosterText, goal, emit,
      maxTasks: opts.maxTasks, maxSteps: opts.maxSteps, cwd: opts.cwd, signal: opts.signal,
    });
  }
  if (opts.signal && opts.signal.aborted) throw new Error('aborted');
  if (!plan) {
    source = 'fallback';
    plan = { subtasks: [{ id: 't1', title: 'Complete the goal', prompt: goal, tier: 'heavy', model: null, owns: [] }], synthesis: '' };
  }

  // Count workers per job so each role's i-th worker starts i rows down its
  // pool when the pool asks to spread.
  const perRole = new Map();
  const tasks = plan.subtasks.map((t, i) => {
    const roleKey = poolOrch ? (router.normalizeRole(t.role) || router.tierToRole(t.tier) || 'coder') : normalizeTier(t.tier);
    const k = perRole.get(roleKey) || 0;
    perRole.set(roleKey, k + 1);
    const chain = chainFor(t.tier, k, t.role, t.model, true);
    const provider = chain ? chain.providers[0] : (opts.provider || null);
    return {
      ...t,
      index: i,
      provider,
      chain,
      model: provider ? provider.model : null,
      tier: normalizeTier(t.tier, (provider && provider.tier) || 'heavy'),
      jobRole: poolOrch ? roleKey : null,
    };
  });

  const planThreads = modeCollab.normalizeThreads(plan, tasks);
  const autoIso = opts.worktreeIsolation === 'auto' || opts.worktreeIsolation === 'worktree';
  const overlapWorktrees = opts.worktreeIsolation === 'auto'
    ? modeCollab.detectOverlappingTasks(tasks)
    : (opts.worktreeIsolation === 'worktree' ? new Set(tasks.map((t) => t.id)) : new Set());
  for (const t of tasks) {
    if (overlapWorktrees.has(t.id) || t.isolation === 'worktree') {
      t.worktree = true;
      t.isolation = 'worktree';
    } else if (autoIso && !t.isolation) {
      t.worktree = Boolean(t.worktree);
    }
  }

  emit({
    type: 'swarm',
    phase: 'planned',
    source,
    threads: planThreads,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, tier: t.tier, role: t.jobRole || undefined, model: t.model, isolation: t.isolation || undefined })),
  });

  // ---- 2. Dispatch ----
  // Every post and member state change is streamed to the UI live, so the
  // Mission Control panel shows the board as it happens (Antigravity's feed).
  const board = createBoard({
    onPost: (msg) => emit({ type: 'swarm', phase: 'board', msg }),
    onMember: (member) => emit({ type: 'swarm', phase: 'member', member }),
  });
  board.setMember('supervisor', { state: 'planning', role: 'supervisor', model: supervisor.model });
  const poolCap = poolOrch ? (router.roleLimit(poolOrch, 'coder') || MAX_CONCURRENCY) : MAX_CONCURRENCY;
  const limit = Math.max(1, Math.min(Number(opts.concurrency) || 4, poolCap, MAX_CONCURRENCY));
  const results = new Array(tasks.length);
  const rounds = new Map();
  const workerControllers = new Map(); // workerName -> AbortController
  const taskByWorker = new Map();
  const dynamicPromises = [];
  let dynamicCount = 0;

  // Concurrency semaphore so a worker parked in `swarm_wait` yields its slot
  // and lets unstarted or dynamically spawned helpers run without deadlocking.
  let activeSlots = 0;
  const slotWaiters = [];
  const acquireSlot = (sig) => {
    if (sig && sig.aborted) return Promise.reject(new Error('aborted'));
    if (activeSlots < limit) { activeSlots++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => {
          if (sig) sig.removeEventListener('abort', onAb);
          activeSlots++;
          resolve();
        },
      };
      const onAb = () => {
        const idx = slotWaiters.indexOf(w);
        if (idx >= 0) slotWaiters.splice(idx, 1);
        reject(new Error('aborted'));
      };
      if (sig) sig.addEventListener('abort', onAb, { once: true });
      slotWaiters.push(w);
    });
  };
  const releaseSlot = () => {
    activeSlots = Math.max(0, activeSlots - 1);
    const next = slotWaiters.shift();
    if (next) next.resolve();
  };

  const usedNames = new Set(['supervisor']);
  const memberNameFor = (task) => {
    if (task.__worker) return task.__worker;
    const base = String(task.title || task.id || 'worker')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'worker';
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = base + '-' + (n++);
    usedNames.add(name);
    task.__worker = name;
    return name;
  };
  tasks.forEach((t) => {
    const wn = memberNameFor(t);
    taskByWorker.set(wn, t);
    board.setMember(wn, { state: 'pending', role: 'worker', tier: t.tier, model: t.model });
  });

  const onAddWorker = async (caller, a = {}) => {
    if (opts.signal && opts.signal.aborted) return 'Swarm stopped.';
    if (dynamicCount >= MAX_DYNAMIC_WORKERS) return `Helper limit reached (${MAX_DYNAMIC_WORKERS} helpers max per swarm).`;
    const prompt = String(a.prompt || a.brief || '').trim();
    if (!prompt) return 'Error: prompt required for swarm_add_worker.';
    dynamicCount++;
    const idx = tasks.length;
    const roleKey = poolOrch ? (router.normalizeRole(a.role) || router.tierToRole(a.tier) || 'coder') : normalizeTier(a.tier);
    const k = perRole.get(roleKey) || 0;
    perRole.set(roleKey, k + 1);
    const chain = chainFor(a.tier || 'heavy', k, a.role, a.model, true);
    const provider = chain ? chain.providers[0] : (opts.provider || null);
    const title = String(a.title || a.name || `helper-${dynamicCount}`).slice(0, 120);
    const newTask = {
      id: 'h' + dynamicCount,
      title,
      prompt,
      tier: normalizeTier(a.tier, (provider && provider.tier) || 'heavy'),
      role: a.role ? router.normalizeRole(a.role) : null,
      jobRole: poolOrch ? roleKey : null,
      model: provider ? provider.model : null,
      owns: Array.isArray(a.owns) ? a.owns.map(String).slice(0, 20) : [],
      addedBy: caller,
      index: idx,
      provider,
      chain,
      __worker: a.name ? (() => {
        const base = String(a.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'helper';
        let nm = base; let n = 2;
        while (usedNames.has(nm)) nm = base + '-' + (n++);
        usedNames.add(nm);
        return nm;
      })() : undefined,
    };
    const handle = memberNameFor(newTask);
    tasks.push(newTask);
    results.push(null);
    taskByWorker.set(handle, newTask);
    board.setMember(handle, { state: 'pending', role: 'worker', tier: newTask.tier, model: newTask.model });
    board.post({ from: caller, to: handle, channel: String(newTask.id), text: `Assigned @${handle} (${title}): ${prompt.slice(0, 240)}` });
    const jobP = (async () => {
      await acquireSlot(opts.signal);
      try { results[idx] = await runOne(newTask, 1, `Spawned by @${caller}. Report back to @${caller} on the board when done.`); }
      finally { releaseSlot(); }
    })().catch(() => {});
    dynamicPromises.push(jobP);
    return `Spawned helper @${handle} (${newTask.id}, ${newTask.model || 'model'}). It is queued/running on the board.`;
  };

  const onKillWorker = (caller, a = {}) => {
    const target = String(a.name || '').replace(/^@+/, '').trim();
    if (!target || !taskByWorker.has(target)) return `No worker named "${target}".`;
    const t = taskByWorker.get(target);
    if (caller !== 'supervisor' && t.addedBy !== caller) {
      return `Permission denied: @${caller} can only kill helpers it spawned (not @${target}).`;
    }
    t.__killed = true;
    const wc = workerControllers.get(target);
    if (wc) { try { wc.abort(); } catch (_) {} }
    board.setMember(target, { state: 'killed', lastSeen: Date.now() });
    board.post({ from: caller, to: target, channel: 'general', text: `Killed @${target}${a.reason ? ': ' + a.reason : ''}` });
    return `Killed worker @${target}.`;
  };

  const onSwitchModel = (caller, a = {}) => {
    const target = String(a.name || caller).replace(/^@+/, '').trim();
    const t = taskByWorker.get(target);
    if (!t) return `No worker named "${target}".`;
    if (caller !== 'supervisor' && target !== caller && t.addedBy !== caller) {
      return `Permission denied: @${caller} cannot switch @${target}'s model.`;
    }
    let nextChain = chainFor(t.tier, t.index || 0, a.role || t.jobRole, a.model || null);
    if (a.model && (!nextChain || !nextChain.providers || !nextChain.providers.length || nextChain.providers[0].model !== a.model)) {
      const base = t.provider || opts.provider || supervisor;
      const pinned = { ...base, model: String(a.model), id: 'pinned:' + a.model };
      const tail = (nextChain && nextChain.providers ? nextChain.providers : []).filter((p) => p && p.model !== pinned.model);
      nextChain = { enabled: true, providers: [pinned].concat(tail), activeIndex: 0, role: 'pinned' };
    }
    if (!nextChain || !nextChain.providers || !nextChain.providers.length) {
      return `No matching model/role found for "${a.model || a.role}".`;
    }
    t.chain = nextChain;
    t.provider = nextChain.providers[0];
    t.model = t.provider.model;
    if (a.role) t.jobRole = router.normalizeRole(a.role) || t.jobRole;
    board.setMember(target, { model: t.model });
    return `Switched @${target} to ${t.model}.`;
  };

  const runOne = async (task, round = 1, briefing = '') => {
    const name = task.title || task.id;
    const agentId = String(task.id);
    const p = task.provider || opts.provider;
    const workerName = memberNameFor(task);
    if (task.__killed) {
      return { id: agentId, name: workerName, title: task.title, tier: task.tier, role: task.jobRole, model: p ? p.model : null, baseURL: p ? p.baseURL : null, status: 'killed', ms: 0, result: '(killed)', round };
    }
    rounds.set(workerName, round);
    const channel = String(task.channel || task.id || 'general');
    const workerAc = new AbortController();
    const onParentAbort = () => workerAc.abort();
    if (opts.signal) {
      if (opts.signal.aborted) workerAc.abort();
      else opts.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    workerControllers.set(workerName, workerAc);
    let isParked = false;
    const bus = boardTools(board, workerName, {
      channel,
      signal: workerAc.signal,
      onWaitStart: () => { if (!isParked) { isParked = true; releaseSlot(); } },
      onWaitEnd: async () => {
        if (!isParked) return;
        try { await acquireSlot(workerAc.signal); isParked = false; }
        catch (e) { isParked = false; activeSlots++; throw e; }
      },
      onAddWorker,
      onKillWorker,
      onSwitchModel,
    });
    board.setMember(workerName, { state: 'working', role: 'worker', tier: task.tier, model: p ? p.model : null });
    const t0 = Date.now();
    let servedBy = p ? p.model : null;
    let subCwd = opts.cwd;
    let worktreeInfo = null;
    const workerTimeoutMs = Math.max(1000, Number(opts.workerTimeoutMs) || 10 * 60 * 1000);
    let workerTimer = null;
    let workerTimedOut = false;
    const armWorkerTimer = () => {
      if (workerTimer) clearTimeout(workerTimer);
      workerTimer = setTimeout(() => {
        workerTimedOut = true;
        try { workerAc.abort(); } catch (_) {}
      }, workerTimeoutMs);
      if (workerTimer.unref) workerTimer.unref();
    };
    const clearWorkerTimer = () => {
      if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
    };
    if ((task.isolation === 'worktree' || task.worktree === true) && subCwd && opts.permissionMode !== 'plan') {
      try {
        const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: subCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const slug = String(workerName || 'worker').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 28) || 'worker';
        const wtBranch = `swm-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        const wtDir = path.join(os.tmpdir(), `akron-${wtBranch}`);
        execFileSync('git', ['worktree', 'add', '-b', wtBranch, wtDir, 'HEAD'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const relSub = path.relative(gitRoot, subCwd);
        subCwd = relSub && !relSub.startsWith('..') ? path.join(wtDir, relSub) : wtDir;
        worktreeInfo = { gitRoot, wtDir, wtBranch, baseHead };
      } catch (_) { worktreeInfo = null; }
    }
    emit({ type: 'subagent', id: agentId, name, status: 'running', role: 'worker', jobRole: task.jobRole, tier: task.tier, model: servedBy, round, worktree: worktreeInfo ? worktreeInfo.wtBranch : undefined });
    try {
      if (workerAc.signal.aborted) throw new Error('aborted');
      armWorkerTimer();
      const out = await trackedRunAgent({
        provider: p,
        orchestrator: task.chain || null,
        messages: [{ role: 'user', content: workerPrompt(String(goal), task, { me: workerName, channel }) + (briefing ? '\n\n' + briefing : '') }],
        maxSteps: opts.maxSteps || 0,
        cwd: subCwd,
        signal: workerAc.signal,
        useMemory: opts.useMemory,
        extraTools: bus.defs,
        localTools: bus.localTools,
        emit: (evt) => {
          if (!evt || evt.type === 'done') return;
          if (evt.type === 'orchestrator' && evt.to) servedBy = evt.to;
          else if (evt.type === 'model' && evt.model && !/^(auto|fast|smart|fusion|default|free|akron-.*)$/i.test(String(evt.model).trim())) {
            servedBy = evt.model;
          }
          emit({ ...evt, subagent: name, agentId, tier: task.tier, model: servedBy });
        },
      });
      const last = [...(out || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      let result = last ? last.content : '(worker finished with no text)';
      let preservedWorktree = null;
      if (worktreeInfo) {
        let dirtyOrCommitted = false;
        try {
          const st = execFileSync('git', ['status', '--porcelain'], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const headCount = Number(execFileSync('git', ['rev-list', '--count', `${worktreeInfo.baseHead}..HEAD`], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) || 0;
          dirtyOrCommitted = Boolean(st) || headCount > 0;
        } catch (_) { dirtyOrCommitted = true; }
        if (dirtyOrCommitted) {
          preservedWorktree = { path: worktreeInfo.wtDir, branch: worktreeInfo.wtBranch };
          result += `\n\n[Worktree preserved: path=${worktreeInfo.wtDir}, branch=${worktreeInfo.wtBranch}]`;
          worktreeInfo = null;
        }
      }
      const ms = Date.now() - t0;
      board.setMember(workerName, { state: 'done', lastSeen: Date.now() });
      emit({ type: 'subagent', id: agentId, name, status: 'done', role: 'worker', jobRole: task.jobRole, tier: task.tier, model: servedBy, ms, round });
      return { id: agentId, name: workerName, title: task.title, tier: task.tier, role: task.jobRole, model: servedBy,
        baseURL: p ? p.baseURL : null, status: 'done', ms, result, round, ...(preservedWorktree ? { worktree: preservedWorktree } : {}) };
    } catch (e) {
      const ms = Date.now() - t0;
      const killed = !!task.__killed;
      const aborted = !killed && ((workerAc.signal.aborted) || /abort/i.test(String(e && e.message)));
      const st = workerTimedOut ? 'error' : (killed ? 'killed' : (aborted ? 'stopped' : 'error'));
      const errText = workerTimedOut ? `Error: worker timed out after ${Math.round(workerTimeoutMs / 1000)}s` : (killed ? '(killed)' : ('Error: ' + (e && e.message)));
      board.setMember(workerName, { state: st, lastSeen: Date.now() });
      emit({ type: 'subagent', id: agentId, name, status: st, role: 'worker', jobRole: task.jobRole, tier: task.tier, model: servedBy, ms, round, error: String((e && e.message) || e).slice(0, 300) });
      return { id: agentId, name: workerName, title: task.title, tier: task.tier, role: task.jobRole, model: servedBy,
        baseURL: p ? p.baseURL : null, status: st, ms, result: errText, round, ...(workerTimedOut ? { timedOut: true } : {}) };
    } finally {
      clearWorkerTimer();
      if (worktreeInfo) {
        let dirtyOrCommitted = false;
        try {
          const st = execFileSync('git', ['status', '--porcelain'], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const headCount = Number(execFileSync('git', ['rev-list', '--count', `${worktreeInfo.baseHead}..HEAD`], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) || 0;
          dirtyOrCommitted = Boolean(st) || headCount > 0;
        } catch (_) {}
        if (!dirtyOrCommitted) {
          try { execFileSync('git', ['worktree', 'remove', '--force', worktreeInfo.wtDir], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
          try { fs.rmSync(worktreeInfo.wtDir, { recursive: true, force: true }); } catch (_) {}
          try { execFileSync('git', ['worktree', 'prune'], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
          try { execFileSync('git', ['branch', '-D', worktreeInfo.wtBranch], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
        }
      }
      if (p && p.model) activeSwarmModels.delete(String(p.model).toLowerCase());
      workerControllers.delete(workerName);
      if (opts.signal) opts.signal.removeEventListener('abort', onParentAbort);
    }
  };

  const pool = async (jobs, fn) => {
    await Promise.all(jobs.map(async (j) => {
      if (opts.signal && opts.signal.aborted) return;
      try { await acquireSlot(opts.signal); } catch (_) { return; }
      if (opts.signal && opts.signal.aborted) { releaseSlot(); return; }
      try { await fn(j); } finally { releaseSlot(); }
    }));
  };

  await pool(tasks.map((t, i) => i), async (i) => { results[i] = await runOne(tasks[i]); });
  while (dynamicPromises.length) {
    const batch = dynamicPromises.splice(0, dynamicPromises.length);
    await Promise.all(batch);
  }
  for (let i = 0; i < tasks.length; i++) {
    if (!results[i]) results[i] = { id: String(tasks[i].id), name: memberNameFor(tasks[i]), title: tasks[i].title, tier: tasks[i].tier, model: tasks[i].model, status: tasks[i].__killed ? 'killed' : 'stopped', ms: 0, result: '(not started — the swarm was stopped)', round: 0 };
  }

  // ---- 2a. Automatic failed-worker retry wave on alternate healthy models ----
  if (opts.retryFailed !== false && !(opts.signal && opts.signal.aborted)) {
    const failedIndices = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r && r.status === 'error' && !(tasks[i] && tasks[i].__killed)) {
        failedIndices.push(i);
      }
    }
    if (failedIndices.length) {
      emit({ type: 'swarm', phase: 'retry', count: failedIndices.length, tasks: failedIndices.map((i) => tasks[i].id) });
      await pool(failedIndices, async (i) => {
        if (opts.signal && opts.signal.aborted) return;
        const task = tasks[i];
        const prevModel = String((results[i] && results[i].model) || '').trim().toLowerCase();
        const altCandidates = roster.filter((c) => {
          const cm = String(c.model || '').trim().toLowerCase();
          return cm && cm !== prevModel && (!gate || typeof gate.usable !== 'function' || gate.usable(c));
        });
        const altBase = altCandidates.length
          ? (pickProvider(altCandidates, task.tier, i + 1) || altCandidates[0])
          : pickProvider(roster, task.tier, i + 1);
        const retryTask = { ...task };
        if (altBase) {
          const rest = roster.filter((c) => c !== altBase);
          retryTask.provider = altBase;
          retryTask.chain = { enabled: true, providers: [altBase].concat(rest), activeIndex: 0, role: 'retry' };
          board.setMember(memberNameFor(task), { model: altBase.model });
        }
        const recoveryBrief = `PREVIOUS ATTEMPT FAILED ON "${(results[i] && results[i].model) || 'unknown'}" WITH:\n${String((results[i] && results[i].result) || '').slice(0, 600)}\n\nRecover cleanly and complete the full subtask cleanly using tools.`;
        const retried = await runOne(retryTask, (rounds.get(memberNameFor(task)) || 1) + 1, recoveryBrief);
        if (retried && retried.status === 'done') {
          results[i] = retried;
        } else if (retried && results[i]) {
          results[i] = { ...retried, result: `${results[i].result}\n\n[Backup retry on ${(retried && retried.model) || 'alternate'} (${retried.status})]: ${String(retried.result || '').slice(0, 500)}` };
        }
      });
    }
  }

  // ---- 2b. Stall monitor + mention wake-ups (event waves) ----
  // Antigravity wakes a member whenever a post addresses it (by `to` or an
  // @mention) and re-briefs a member whose turn ended without reporting. Run
  // waves until nobody is addressed any more, bounded per member.
  if (opts.monitor !== false) {
    const delivered = new Map(); // member -> last seq it was woken for
    for (let wave = 0; wave < MAX_ROUNDS_PER_MEMBER; wave++) {
      if (opts.signal && opts.signal.aborted) break;
      const byName = new Map(results.filter(Boolean).map((r, i) => [r.name, i]));
      const redo = new Map();
      if (wave === 0 && board.messages.length > 0) {
        for (const r of results) {
          if (r && r.status === 'done' && !((board.member(r.name) || {}).posts)) redo.set(r.name, { reason: 'stall' });
        }
      }
      for (const [who] of byName) {
        if (redo.has(who)) continue;
        if ((rounds.get(who) || 1) >= MAX_ROUNDS_PER_MEMBER) continue;
        const r = results[byName.get(who)];
        if (!r || r.status === 'stopped' || r.status === 'killed' || (tasks[byName.get(who)] && tasks[byName.get(who)].__killed)) continue;
        const since = Math.max(delivered.get(who) || 0, (board.member(who) || {}).readSeq || 0);
        const msgs = board.addressedTo(who, { since }).filter((m) => m.from !== who);
        if (msgs.length) redo.set(who, { reason: 'mention', msgs });
      }
      if (!redo.size) break;
      emit({ type: 'swarm', phase: 'monitor', wave: wave + 1, stalled: [...redo].filter(([, w]) => w.reason === 'stall').map(([n]) => n), addressed: [...redo].filter(([, w]) => w.reason === 'mention').map(([n]) => n) });
      await pool([...redo.entries()], async ([who, why]) => {
        const idx = byName.get(who);
        if (idx == null) return;
        delivered.set(who, board.seq);
        const task = tasks[idx];
        const promptIntent = why.reason === 'stall'
          ? STALL_NOTE
          : 'A team member addressed you on the board:\n'
            + why.msgs.map((m) => `#${m.seq} ${m.from}: ${m.text}`).join('\n')
            + '\nAnswer them on the board and finish the part of your subtask that is still missing.';
        const prior = results[idx] && results[idx].result
          ? `\n\nYOUR PREVIOUS REPORT:\n${String(results[idx].result).slice(0, 4000)}` : '';
        const again = await runOne(task, (rounds.get(who) || 1) + 1, promptIntent + prior);
        if (again.status === 'done') {
          results[idx] = { ...again,
            result: (results[idx] && results[idx].result ? results[idx].result + '\n\n' : '') + again.result };
        } else if (results[idx]) {
          results[idx] = { ...results[idx], result: results[idx].result + `\n\n(follow-up round ${again.round} ${again.status}: ${String(again.result).slice(0, 300)})` };
        }
      });
    }
  }
  while (dynamicPromises.length) {
    const batch = dynamicPromises.splice(0, dynamicPromises.length);
    await Promise.all(batch);
  }

  const done = results.filter(Boolean);
  emit({ type: 'swarm', phase: 'dispatched', results: done.map((r) => ({ id: r.id, title: r.title, tier: r.tier, role: r.role, model: r.model, status: r.status, ms: r.ms })) });
  if (opts.signal && opts.signal.aborted) throw new Error('aborted');

  // ---- 3. Supervisor review / merge ----
  let answer = '';
  let reviewError = null;
  if (opts.critique !== false) {
    board.setMember('supervisor', { state: 'reviewing' });
    emit({ type: 'subagent', id: 'supervisor', name: 'supervisor (review)', status: 'running', role: 'supervisor', tier: 'critical', model: supervisor.model });
    const report = done.map((r) => `### ${r.title} — ${r.role || r.tier} — ${r.model || 'model'} — ${r.status} (${r.ms}ms)\n${r.result}`).join('\n\n');
    const feed = board.messages.length ? board.transcript({ limit: 200 }) : '';
    const boardBlock = feed ? `\n\nSWARM BOARD (workers' own messages, oldest first):\n${feed}\n` : '';
    const envelopes = done.map((r) => ({ r, env: modeCollab.parseWorkerEnvelope(r.result) }));
    const touchedSet = new Set();
    const checksList = [];
    const wtBranches = [];
    for (const { r, env } of envelopes) {
      for (const f of env.files) touchedSet.add(f);
      for (const c of env.checks) checksList.push(`${r.name}: ${c}`);
      if (r.worktree && r.worktree.branch) wtBranches.push(`${r.name} -> ${r.worktree.branch} (${r.worktree.path})`);
    }
    const files = touchedSet.size || done.some((r) => /\.(html?|css|js|jsx|tsx|ts|json|md|py)\b/i.test(r.result))
      ? `\nThe team reported creating/updating files${touchedSet.size ? ' (' + [...touchedSet].slice(0, 12).join(', ') + ')' : ''}.${wtBranches.length ? ' Preserved worker branches: ' + wtBranches.join('; ') + '.' : ''}${checksList.length ? ' Reported checks: ' + checksList.slice(0, 6).join('; ') + '.' : ''} Verify the key files exist (Read/Glob, or run the tests with Bash) and make sure the final answer names the entry file.\n` : '';
    try {
        const hasWorkerErrors = done.some((r) => r && r.status === 'error');
        const effectiveReviewTools = (opts.readOnly === true || opts.permissionMode === 'plan')
          ? READONLY_REVIEW_TOOLS
          : ((opts.allowReviewRepair === true || hasWorkerErrors) ? REVIEW_TOOLS : READONLY_REVIEW_TOOLS);
        const out = await trackedRunAgent({
          provider: supervisor,
          orchestrator: supervisorOrch,
          messages: [{
            role: 'user',
            content: SUPERVISOR_MERGE_PROMPT
              .replace('{FILES}', files)
              .replace('{RESULTS}', report + boardBlock)
              .replace('{GOAL}', String(goal)) + (plan.synthesis ? `\n\nMERGE INSTRUCTION FROM THE PLAN: ${plan.synthesis}` : ''),
          }],
          maxSteps: 40,
          cwd: opts.cwd,
          signal: opts.signal,
          useMemory: false,
          toolAllow: effectiveReviewTools,
        emit: (evt) => { if (evt && evt.type === 'done') return; emit({ ...evt, subagent: 'supervisor', role: 'supervisor' }); },
      });
      const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
      answer = last ? last.content : '';
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      reviewError = e.message;
    }
    board.setMember('supervisor', { state: reviewError ? 'error' : 'done' });
    emit({ type: 'subagent', id: 'supervisor', name: 'supervisor (review)', status: reviewError ? 'error' : 'done', role: 'supervisor', tier: 'critical', model: supervisor.model });
  }

  if (!answer) {
    answer = done.map((r) => `### ${r.title} (${r.role || r.tier} · ${r.model || 'model'})\n${r.result}`).join('\n\n');
  }

  if (!swarmUsage.model) swarmUsage.model = supervisor.model;
  const summary = {
    supervisor: { model: supervisor.model, baseURL: supervisor.baseURL, reasoningLevel: supervisor.reasoningLevel || 'high' },
    planSource: source,
    pools: !!poolOrch,
    threads: planThreads,
    tasks: tasks.map(({ chain, provider, ...t }) => ({ ...t, model: t.model })),
    results: done,
    board: board.messages.map((m) => ({ ...m })),
    members: board.status(),
    answer,
    reviewError,
    usage: swarmUsage.total_tokens > 0 ? { ...swarmUsage } : null,
    ms: Date.now() - started,
  };
  emit({ type: 'swarm', phase: 'done', ms: summary.ms, answer: answer.slice(0, 4000) });
  return summary;
}

module.exports = {
  TIER_RANK, normalizeTier, ensureHighThinkingSupervisor, buildRoster, pickProvider, rosterSummary, isFrontier,
  extractJSON, normalizePlan, swarm, decompose,
  createBoard, boardTools, STALL_NOTE, PLAN_TOOLS, READONLY_REVIEW_TOOLS, REVIEW_TOOLS, MAX_CONCURRENCY,
  SUPERVISOR_PLAN_PROMPT, SUPERVISOR_MERGE_PROMPT,
};
