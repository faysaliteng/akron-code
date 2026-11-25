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
const FRONTIER_RE = /(kimi|moonshot|deepseek|glm|zhipu|chatgpt|gpt-?[45]|\bo[1-4]\b|anthropic|sonnet|opus|haiku|gemini[- ]?(pro|ultra)|qwen.*(max|235b)|grok|command-r-plus|mistral-large|frontier)/i;
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

function createBoard() {
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
      return msg;
    },
    read({ since = 0, channel = null, limit = 200 } = {}) {
      const from = Math.max(0, Number(since) || 0);
      let out = messages.filter((m) => m.seq > from);
      if (channel && channel !== '*') out = out.filter((m) => m.channel === channel || m.to);
      return out.slice(0, Math.max(1, Number(limit) || 200));
    },
    // Messages that concern `me`: an explicit `to`, or an @mention in the text.
    addressedTo(me, { since = 0 } = {}) {
      const meRe = new RegExp('@' + String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      return messages.filter((m) => m.seq > (Number(since) || 0)
        && (m.to === me || meRe.test(m.text)));
    },
    setMember(name, patch = {}) {
      const id = String(name || '');
      if (!id) return null;
      const cur = members.get(id) || { name: id, state: 'idle', posts: 0, lastSeq: 0 };
      Object.assign(cur, patch, { at: Date.now() });
      members.set(id, cur);
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
      const list = board.read({ since: a.since == null ? lastSeq : a.since, channel: a.channel || null, limit: a.limit || 200 });
      if (!list.length) return 'board: no new messages';
      const hi = list[list.length - 1].seq;
      lastSeq = Math.max(lastSeq, hi);
      return list.map((m) => `#${m.seq} ${m.from}${m.to ? ' → @' + m.to : ''} [${m.channel}]: ${m.text}`).join('\n')
        + `\n(last seq ${hi} — pass since:${hi} next time)`;
    });

  add('swarm_wait',
    'Park until a new board message arrives (or `timeout_ms` elapses). Use only when blocked on another worker; never poll it in a loop.',
    { type: 'object', properties: { since: { type: 'number', description: 'Last seq you have seen.' }, mentions_only: { type: 'boolean', description: 'Only wake for messages addressed to you.' }, timeout_ms: { type: 'number' } } },
    async (a = {}) => {
      const since = a.since == null ? lastSeq : Number(a.since);
      const res = await board.wait({
        me,
        since,
        mentionsOnly: !!a.mentions_only,
        timeoutMs: a.timeout_ms || 20000,
        signal: opts.signal,
      });
      if (!res.messages.length) return res.aborted ? 'board: wait aborted' : 'board: no new messages (timeout) — continue your own work';
      const hi = res.messages[res.messages.length - 1].seq;
      lastSeq = Math.max(lastSeq, hi);
      return res.messages.map((m) => `#${m.seq} ${m.from}${m.to ? ' → @' + m.to : ''} [${m.channel}]: ${m.text}`).join('\n');
    });

  add('swarm_status',
    'List swarm members and their last known state.',
    { type: 'object', properties: {} },
    () => board.status().map((m) => `${m.name}: ${m.state}${m.posts ? ` (${m.posts} posts)` : ''}`).join('\n') || 'board: no members');

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
  // One board for the whole swarm: workers post intent + hand-off notes, read
  // each other's posts, and park in swarm_wait when blocked. The board is also
  // the source of truth handed to the supervisor at review time.
  const board = createBoard();
  board.setMember('supervisor', { state: 'planning', role: 'supervisor' });
  const limit = Math.max(1, Number(opts.concurrency) || 4);
  const results = new Array(tasks.length);
  let cursor = 0;

  // A member's board handle has to be something a *model* will type: `@api`,
  // `@ui`, not `@t1`. Derive it from the subtask title, keep it stable across a
  // re-brief (so mentions still reach the same member) and unique per swarm.
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

  const runOne = async (task, round = 1, briefing = '') => {
    const name = task.title || task.id;
    const agentId = String(task.id);
    const p = task.provider || opts.provider;
    const workerName = memberNameFor(task);
    const channel = String(task.channel || task.id || 'general');
    const bus = boardTools(board, workerName, { channel, signal: opts.signal });
    board.setMember(workerName, { state: 'running', role: 'worker', tier: task.tier, model: p ? p.model : null });
    const t0 = Date.now();
    emit({ type: 'subagent', id: agentId, name, status: 'running', role: 'worker', tier: task.tier, model: p ? p.model : null });
    try {
      const out = await runAgent({
        provider: p,
        messages: [{ role: 'user', content: workerPrompt(String(goal), task, { me: workerName, channel }) + (briefing ? '\n\n' + briefing : '') }],
        maxSteps: opts.maxSteps || 0,
        cwd: opts.cwd,
        signal: opts.signal,
        useMemory: opts.useMemory,
        extraTools: bus.defs,
        localTools: bus.localTools,
        emit: (evt) => emit({ ...evt, subagent: name, agentId, tier: task.tier, model: p ? p.model : null }),
      });
      const last = [...(out || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      const result = last ? last.content : '(worker finished with no text)';
      const ms = Date.now() - t0;
      board.setMember(workerName, { state: 'done', lastSeen: Date.now() });
      emit({ type: 'subagent', id: agentId, name, status: 'done', role: 'worker', tier: task.tier, model: p ? p.model : null, ms });
      return { id: agentId, name: workerName, title: task.title, tier: task.tier, model: p ? p.model : null,
        baseURL: p ? p.baseURL : null, status: 'done', ms, result, round };
    } catch (e) {
      const ms = Date.now() - t0;
      board.setMember(workerName, { state: 'error', lastSeen: Date.now() });
      emit({ type: 'subagent', id: agentId, name, status: 'error', role: 'worker', tier: task.tier, model: p ? p.model : null, ms });
      return { id: agentId, name: workerName, title: task.title, tier: task.tier, model: p ? p.model : null,
        baseURL: p ? p.baseURL : null, status: 'error', ms, result: 'Error: ' + e.message, round };
    }
  };

  const next = async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await runOne(tasks[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));

  // ---- 2b. Stall monitor + mention wake-ups ----
  // Antigravity keeps a stall monitor that re-briefs a member whose turn ended
  // without moving, and wakes a member that was addressed by name. Both are
  // host-side here: one bounded extra round, only for members that need it.
  if (opts.monitor !== false) {
    const byName = new Map(results.filter(Boolean).map((r) => [r.name, r]));
    // Re-briefing only makes sense once the board is actually in use. If no
    // worker posted at all, the swarm ran as a plain fan-out; paying a second
    // round on every worker there would double the token cost for no gain.
    const boardInUse = board.messages.length > 0;
    const stalled = !boardInUse ? [] : results.filter((r) => r && r.status === 'done'
      && (!board.member(r.name) || !board.member(r.name).posts));
    const addressed = new Map();
    for (const m of board.messages) {
      if (!m.to || m.from === m.to) continue;
      if (!byName.has(m.to)) continue;
      const cur = addressed.get(m.to) || [];
      cur.push(m);
      addressed.set(m.to, cur);
    }
    const redo = new Map();
    for (const r of stalled) redo.set(r.name, { reason: 'stall' });
    for (const [who, msgs] of addressed) {
      if (redo.has(who)) continue;
      const target = byName.get(who);
      if (!target) continue;
      if (target.round > 1) continue; // one wake-up per member
      redo.set(who, { reason: 'mention', msgs });
    }
    if (redo.size) {
      emit({ type: 'swarm', phase: 'monitor', stalled: stalled.map((r) => r.name), addressed: [...addressed.keys()] });
      await Promise.all([...redo.entries()].map(async ([who, why]) => {
        const idx = results.findIndex((r) => r && r.name === who);
        if (idx < 0) return;
        const task = tasks[idx];
        const promptIntent = why.reason === 'stall'
          ? STALL_NOTE
          : 'A team member addressed you on the board:\n'
            + why.msgs.map((m) => `#${m.seq} ${m.from}: ${m.text}`).join('\n')
            + '\nAnswer them on the board and finish the part of your subtask that is still missing.';
        // Re-brief, not restart: hand the worker its own prior report plus the
        // board state, so round 2 continues the subtask instead of redoing it.
        const prior = results[idx] && results[idx].result
          ? `\n\nYOUR PREVIOUS REPORT:\n${String(results[idx].result).slice(0, 4000)}` : '';
        const again = await runOne(task, 2, promptIntent + prior);
        if (again.status === 'done') {
          results[idx] = { ...again,
            result: (results[idx] && results[idx].result ? results[idx].result + '\n\n' : '') + again.result };
        }
      }));
    }
  }

  const done = results.filter(Boolean);
  emit({ type: 'swarm', phase: 'dispatched', results: done.map((r) => ({ id: r.id, title: r.title, tier: r.tier, model: r.model, status: r.status, ms: r.ms })) });

  // ---- 3. Supervisor review / merge ----
  let answer = '';
  let reviewError = null;
  if (opts.critique !== false) {
    emit({ type: 'subagent', id: 'supervisor', name: 'supervisor (review)', status: 'running', role: 'supervisor', tier: 'critical', model: supervisor.model });
    const report = done.map((r) => `### ${r.title} — ${r.tier} — ${r.model || 'model'} — ${r.status} (${r.ms}ms)\n${r.result}`).join('\n\n');
    // The board is the swarm's shared state: what each worker claimed, what it
    // handed off, and who asked whom for what. Give the supervisor that feed so
    // it can catch two workers that duplicated work or agreed on different APIs.
    const feed = board.messages.length ? board.transcript({ limit: 200 }) : '';
    const boardBlock = feed ? `\n\nSWARM BOARD (workers' own messages, oldest first):\n${feed}\n` : '';
    const files = done.filter((r) => /\.(html?|css|js|jsx|tsx|ts|json|md|py)\b/i.test(r.result)).length
      ? '\nThe team reported creating files. Make sure the final answer names the entry file.\n' : '';
    try {
      const out = await runAgent({
        provider: supervisor,
        messages: [{
          role: 'user',
          content: SUPERVISOR_MERGE_PROMPT
            .replace('{FILES}', files)
            .replace('{RESULTS}', report + boardBlock)
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
    board: board.messages.map((m) => ({ ...m })),
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
  createBoard, boardTools, STALL_NOTE,
  SUPERVISOR_PLAN_PROMPT, SUPERVISOR_MERGE_PROMPT,
};
