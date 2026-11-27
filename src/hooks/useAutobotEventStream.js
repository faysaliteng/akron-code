import { useEffect } from 'react';
import { summarizeChangedFiles } from '../components/LiveProgress.jsx';
import { uid, cleanErr, sendDesktopNotification } from '../utils/appHelpers.jsx';

export function useAutobotEventStream({
  runIdRef, liveRef, runStartedAtRef, runConvRef, activeIdRef, settingsRef,
  setLiveSync, setThinking, setSubAgents, setSwarmInfo, setSwarmBoard,
  setPaused, setPermError, setPermissionQueue, setLastUsage,
  commitLive, setError, setModelMenuOpen, setQuestionQueue,
  setShowSettings, setPanel, setActiveId, setCuConsent,
  setPermissions, setPlanMode, setArtifactsExplicit, setNotice,
  openPreview, setCwd, setGoal, setCompliance, selectConv, newChat, inputRef,
}) {
  useEffect(() => {
    const off = window.autobot.onEvent((evt) => {
      // A run emits `done` (stream finished) and then `complete` (run promise
      // settled). Those late events used to land after the NEXT run had already
      // started and clobber it — drop anything still tagged with an older run.
      if (evt.runId && runIdRef.current && evt.runId !== runIdRef.current
        && /^(delta|thinking|tool|toolStream|toolResult|done|complete|cancelled|error|notice|limit|retry|usage|subagent|swarm|paused)$/.test(evt.type)) return;
      // A sub-agent's events belong to ITS row, never to the parent reply. Without
      // this, three concurrent workers interleaved their tokens into one garbled
      // paragraph ("done on cheadone on mid-…"), every worker tool row landed in
      // the parent's tool list, and a child's `done` / `complete` / `error` ended
      // the PARENT's stream (commitLive) mid-run. Anything tagged with a
      // sub-agent is consumed here — except events that need the user (question,
      // permission, consent, plan) or surface UI (artifact, preview, nested
      // subagent/swarm rows), which still flow to the shared handlers below.
      const subTag = evt.subagent != null ? String(evt.subagent) : (evt.agentId != null ? String(evt.agentId) : '');
      if (subTag && evt.type === 'checkpoint') {
        const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
        setLiveSync((l) => (l ? { ...l, checkpointId: cp.id, checkpoints: [...(l.checkpoints || []), cp] } : l));
        return;
      }
      if (subTag && !/^(question|plan|permission|computerUseConsent|permissionMode|planMode|artifact|preview|subagent|swarm|cwd|deeplink|compliance)$/.test(evt.type)) {
        const agentKey = evt.agentId != null ? String(evt.agentId) : '';
        const normHandle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        setSubAgents((prev) => prev.map((a) => {
          const hit = a.key === subTag || a.name === subTag || (agentKey && a.key === agentKey) || (a.handle && a.handle === normHandle(subTag));
          if (!hit) return a;
          const p = a.progress || { chars: 0, tools: 0, last: '', log: [] };
          switch (evt.type) {
            case 'delta': {
              const chars = p.chars + String(evt.text || '').length;
              return { ...a, progress: { ...p, chars, last: (p.last + String(evt.text || '')).slice(-500) } };
            }
            case 'thinking': return { ...a, progress: { ...p, think: (p.think || 0) + String(evt.text || '').length } };
            case 'tool': {
              const args = evt.args || {};
              const shortArg = String(args.path || args.file_path || args.command || args.pattern || args.query || args.text || '').replace(/\s+/g, ' ').slice(0, 80);
              const entry = { kind: 'tool', id: evt.id || '', name: evt.name, arg: shortArg, at: Date.now() };
              const log = [...(p.log || []), entry].slice(-20);
              return { ...a, progress: { ...p, tools: p.tools + 1, currentTool: { name: evt.name, arg: shortArg }, log, last: p.last || ('using ' + evt.name) } };
            }
            case 'toolResult': {
              const log = (p.log || []).slice();
              for (let j = log.length - 1; j >= 0; j--) {
                if ((evt.id && log[j].id === evt.id) || log[j].name === evt.name) {
                  log[j] = { ...log[j], done: true, isError: !!evt.isError };
                  break;
                }
              }
              return { ...a, progress: { ...p, log } };
            }
            case 'orchestrator':
              return {
                ...a,
                model: evt.to || a.model,
                failover: { from: evt.from, to: evt.to, reason: evt.reason, count: ((a.failover && a.failover.count) || 0) + 1 },
              };
            case 'retry': return { ...a, progress: { ...p, retried: (p.retried || 0) + 1 } };
            case 'notice': return { ...a, progress: { ...p, notice: String(evt.text || '') } };
            case 'error': return { ...a, status: 'error', progress: { ...p, last: String(evt.message || 'error').slice(-400) } };
            // done / complete / cancelled / usage / limit: lifecycle `subagent` owns status.
            default: return a;
          }
        }));
        return;
      }
      switch (evt.type) {
        case 'retry':
          // The turn was cut at the token limit and is being re-generated. Drop
          // the truncated attempt so the transcript shows one clean answer, the
          // way Example replaces a cut-off message instead of stacking a second.
          setLiveSync((l) => {
            if (!l) return l;
            const segments = (l.segments || []).slice();
            let text = Number(evt.chars) || 0;
            let think = Number(evt.thinkingChars) || 0;
            for (let i = segments.length - 1; i >= 0 && (text > 0 || think > 0); i--) {
              const seg = segments[i];
              if (seg.type === 'text' && text > 0) {
                const drop = Math.min(text, seg.text.length);
                text -= drop;
                segments[i] = { ...seg, text: seg.text.slice(0, seg.text.length - drop) };
              } else if (seg.type === 'thinking' && think > 0) {
                const drop = Math.min(think, seg.text.length);
                think -= drop;
                segments[i] = { ...seg, text: seg.text.slice(0, seg.text.length - drop) };
              }
            }
            const kept = segments.filter((s) => s.type === 'tools' || (s.text && s.text.trim()));
            const content = kept.filter((s) => s.type === 'text').map((s) => s.text).join('');
            return { ...l, content, segments: kept };
          });
          break;
        case 'delta':
          setThinking('');
          // Each agent step is its own text block. Appending every step into one
          // string glued sentences together ("…planning.Empty project.") and stacked
          // every tool row above the whole reply, so a long run read as one wall of
          // text. Keep an ordered segment list instead: text, tools, text, tools…
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'text') segments[segments.length - 1] = { type: 'text', text: last.text + evt.text };
            else segments.push({ type: 'text', text: evt.text });
            return { ...base, content: base.content + evt.text, segments, streamingTool: null };
          });
          break;
        case 'thinking':
          // Example shows reasoning inline in the transcript ("Thought for 4s"),
          // not just in the status line. Keep it as an ordered segment so the
          // record reads: thinking → text → tools → text, in the real order.
          setThinking((t) => t + evt.text);
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            const GROW = 12000; // reasoning models can stream huge traces; keep a tail
            if (last && last.type === 'thinking') {
              const merged = last.text + evt.text;
              segments[segments.length - 1] = { type: 'thinking', text: merged.length > GROW ? merged.slice(-GROW) : merged };
            } else {
              segments.push({ type: 'thinking', text: evt.text });
            }
            return { ...base, segments };
          });
          break;
        case 'toolStream': {
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const prev = base.streamingTool;
            const startedAt = (prev && prev.name === evt.name && (!evt.id || prev.id === evt.id)) ? prev.startedAt : Date.now();
            const tools = Array.isArray(base.tools) && evt.id
              ? base.tools.map((t) => (t.id === evt.id && t.status === 'running'
                ? { ...t, liveBytes: Number(evt.bytes) || 0, liveLines: Number(evt.lines) || 0, livePreview: evt.preview || t.livePreview || '' }
                : t))
              : (base.tools || []);
            return {
              ...base,
              tools,
              streamingTool: {
                id: evt.id || '',
                name: evt.name || '',
                bytes: Number(evt.bytes) || 0,
                lines: Number(evt.lines) || 0,
                target: evt.target || '',
                preview: evt.preview || '',
                phase: evt.phase || 'args',
                startedAt,
                at: Date.now(),
              },
            };
          });
          break;
        }
        case 'tool': {
          // A provider that omits the call id must not collapse every such row
          // onto `undefined` (one shared key, results landing on the wrong row).
          const tid = evt.id || uid();
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'tools') segments[segments.length - 1] = { type: 'tools', ids: [...last.ids, tid] };
            else segments.push({ type: 'tools', ids: [tid] });
            const st = base.streamingTool;
            const seededBytes = (st && (st.id === tid || st.name === evt.name)) ? st.bytes : 0;
            const seededLines = (st && (st.id === tid || st.name === evt.name)) ? st.lines : 0;
            return {
              ...base,
              streamingTool: null,
              tools: [...(base.tools || []), { id: tid, name: evt.name, args: evt.args, result: null, status: 'running', startedAt: Date.now(), liveBytes: seededBytes, liveLines: seededLines }],
              segments,
            };
          });
          break;
        }
        case 'paused':
          setPaused(!!evt.paused);
          break;
        case 'toolResult':
          setLiveSync((l) => {
            if (!l) return l;
            return { ...l, tools: l.tools.map((t) => (t.id === evt.id ? { ...t, result: evt.result, status: evt.isError ? 'error' : 'done' } : t)) };
          });
          break;
        case 'done':
        case 'complete': {
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          if (evt && evt.usage) setLastUsage({ ...evt.usage, model: evt.usage.model || (evt.usage && evt.usage.model) || null, at: Date.now() });
          const snapTools = (liveRef.current && liveRef.current.tools) || [];
          const snapCps = (liveRef.current && liveRef.current.checkpoints) || [];
          const elapsedSec = runStartedAtRef.current ? Math.max(1, Math.round((Date.now() - runStartedAtRef.current) / 1000)) : 0;
          const touched = summarizeChangedFiles(snapTools, snapCps).files.length;
          const summaryBits = [
            elapsedSec ? `Finished in ${elapsedSec}s` : 'Agent finished working in your workspace',
            touched > 0 ? `${touched} file${touched === 1 ? '' : 's'} updated` : '',
          ].filter(Boolean);
          commitLive();
          sendDesktopNotification('agent', 'Akron Code', summaryBits.join(' · ') + '.', settingsRef.current, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          break;
        }
        case 'cancelled':
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          // Stopping keeps whatever the model had already produced.
          commitLive();
          break;
        case 'error':
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          // Preserve anything already streamed, then show the failure.
          commitLive();
          setError(cleanErr(evt.message));
          sendDesktopNotification('errors', 'Akron Code · Error', cleanErr(evt.message), settingsRef.current, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          // A dead credential is fixed by signing in, not by retrying — open the
          // model menu so the button that resolves it is one click away.
          if (evt.needsSignIn) setModelMenuOpen(true);
          break;
        case 'question': {
          const convTarget = evt.convId || runConvRef.current || activeIdRef.current || null;
          const item = {
            id: evt.id,
            runId: evt.runId || runIdRef.current || null,
            convId: convTarget,
            type: 'question',
            text: evt.question,
            questions: Array.isArray(evt.questions) && evt.questions.length ? evt.questions : null,
            options: evt.options || [],
          };
          setQuestionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('questions', 'Akron Code needs input', evt.question, settingsRef.current, { convId: convTarget });
          break;
        }
        case 'plan': {
          const convTarget = evt.convId || runConvRef.current || activeIdRef.current || null;
          const item = {
            id: evt.id,
            runId: evt.runId || runIdRef.current || null,
            convId: convTarget,
            type: 'plan',
            text: evt.plan,
            allowedPrompts: evt.allowedPrompts || [],
            options: [],
          };
          setQuestionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('questions', 'Akron Code · Plan approval', 'Review proposed execution plan.', settingsRef.current, { convId: convTarget });
          break;
        }
        case 'questionCleared':
          setQuestionQueue((q) => q.filter((x) => {
            if (evt.id) return x.id !== evt.id;
            if (evt.runId) return x.runId !== evt.runId;
            return false;
          }));
          break;
        case 'permission': {
          const item = {
            id: evt.id,
            runId: evt.runId || runIdRef.current || null,
            convId: evt.convId || runConvRef.current || activeIdRef.current || null,
            tool: evt.tool,
            args: evt.args || {},
            summary: evt.summary || '',
            suggestedRule: evt.suggestedRule || null,
          };
          setPermError('');
          setPermissionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('permissions', 'Permission required', `${evt.tool}: ${evt.summary || 'approval needed'}`, settingsRef.current, { convId: item.convId });
          break;
        }
        case 'permissionCleared':
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => {
            if (evt.id) return p.id !== evt.id;
            if (evt.runId) return p.runId !== evt.runId;
            return false;
          }));
          break;
        case 'notificationClick':
          setShowSettings(false);
          setPanel('chats');
          if (evt.convId) setActiveId(evt.convId);
          break;
        case 'computerUseConsent':
          // Desktop's `computer:request_access` / `request_full_control` /
          // `request_teach_access`. The turn is blocked until the user answers.
          setCuConsent({ id: evt.id, tier: evt.tier || 'access', tool: evt.tool || '', sensitive: !!evt.sensitive });
          sendDesktopNotification('permissions', 'Computer Use approval needed', `Allow ${evt.tier || 'access'} for ${evt.tool || 'desktop action'}?`, settingsRef.current, { convId: runConvRef.current || activeIdRef.current || null });
          break;
        case 'permissionMode':
          // Plan mode (or any mode change) requested by the agent itself, e.g.
          // EnterPlanMode / ExitPlanMode approval. Keep the pill in sync.
          if (evt.mode) setPermissions(evt.mode);
          break;
        case 'planMode':
          setPlanMode(evt.active ? { active: true, file: evt.file || 'PLAN.md' } : null);
          break;
        case 'orchestrator':
          setLiveSync((l) => (l ? { ...l, failover: { from: evt.from, to: evt.to, reason: evt.reason }, model: evt.to || l.model } : l));
          break;
        case 'model':
          setLiveSync((l) => {
            if (!l) return l;
            return {
              ...l,
              model: evt.model || l.model || '',
              modelsUsed: Array.isArray(evt.modelsUsed) && evt.modelsUsed.length ? evt.modelsUsed : l.modelsUsed,
            };
          });
          break;
        case 'checkpoint': {
          const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [], checkpoints: [] };
            return { ...base, checkpointId: cp.id, checkpoints: [...(base.checkpoints || []), cp] };
          });
          break;
        }
        case 'subagent': {
          const key = String(evt.id || evt.name || 'agent');
          const status = evt.status === 'started' || evt.status === 'running' ? 'running'
            : evt.status === 'queued' ? 'queued'
              : evt.status === 'waiting' ? 'waiting'
                : evt.status === 'error' ? 'error'
                  : evt.status === 'killed' ? 'killed'
                    : evt.status === 'stopped' ? 'stopped' : 'done';
          const handle = String(evt.name || evt.id || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
          setSubAgents((prev) => {
            const next = [...prev];
            const i = next.findIndex((a) => a.key === key);
            const cur = i >= 0 ? next[i] : null;
            const row = {
              key,
              handle: (cur && cur.handle) || handle,
              name: evt.name || (cur ? cur.name : key),
              status,
              role: evt.role || (cur ? cur.role : null),
              jobRole: evt.jobRole || (cur ? cur.jobRole : null),
              model: evt.model || (cur ? cur.model : null),
              tier: evt.tier || (cur ? cur.tier : null),
              round: evt.round || (cur ? cur.round : 1),
              ms: evt.ms != null ? evt.ms : (cur ? cur.ms : null),
              startedAt: (cur && cur.startedAt) || Date.now(),
              failover: cur ? cur.failover : null,
              posts: cur ? cur.posts || 0 : 0,
              progress: cur ? cur.progress : undefined,
            };
            if (i >= 0) next[i] = row; else next.push(row);
            return next;
          });
          if (evt.background && (status === 'done' || status === 'error')) {
            sendDesktopNotification(
              status === 'error' ? 'errors' : 'agent',
              status === 'error' ? 'Akron Code · Background agent error' : 'Akron Code · Background agent complete',
              `${evt.name || 'Sub-agent'} ${status === 'error' ? 'failed' : 'finished'}.`,
              settingsRef.current,
              { convId: evt.convId || runConvRef.current || activeIdRef.current || null }
            );
          }
          break;
        }
        case 'swarm': {
          if (evt.phase === 'start') {
            setSwarmInfo({ supervisor: evt.supervisor, roster: evt.roster || [], pools: !!evt.pools, phase: 'planning', wave: 0, startedAt: Date.now() });
            setSwarmBoard([]);
          } else if (evt.phase === 'planned') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'dispatch', taskCount: (evt.tasks || []).length }));
            setSubAgents((prev) => {
              const byKey = new Map(prev.map((a) => [a.key, a]));
              (evt.tasks || []).forEach((t) => {
                const key = String(t.id);
                const cur = byKey.get(key);
                const handle = String(t.title || t.id || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
                byKey.set(key, {
                  key,
                  handle: (cur && cur.handle) || handle,
                  name: t.title || t.id,
                  status: cur && cur.status !== 'queued' ? cur.status : 'queued',
                  role: 'worker',
                  jobRole: t.role || (cur && cur.jobRole) || null,
                  model: t.model || (cur && cur.model) || null,
                  tier: t.tier || (cur && cur.tier) || null,
                  round: (cur && cur.round) || 1,
                  ms: cur && cur.ms != null ? cur.ms : null,
                  startedAt: (cur && cur.startedAt) || Date.now(),
                  failover: cur ? cur.failover : null,
                  posts: (cur && cur.posts) || 0,
                  progress: cur ? cur.progress : undefined,
                });
              });
              return [...byKey.values()];
            });
          } else if (evt.phase === 'board' && evt.msg) {
            setSwarmBoard((prev) => {
              if (prev.some((m) => m.seq === evt.msg.seq)) return prev;
              return [...prev, evt.msg].slice(-200);
            });
          } else if (evt.phase === 'member' && evt.member) {
            const mem = evt.member;
            if (mem.name === 'supervisor') {
              setSwarmInfo((w) => ({
                ...(w || {}),
                supervisorState: mem.state,
                phase: mem.state === 'reviewing' ? 'review' : (w && w.phase),
              }));
            } else {
              setSubAgents((prev) => {
                const next = [...prev];
                const idx = next.findIndex((a) => a.handle === mem.name || a.key === mem.name || a.name === mem.name);
                const mapped = mem.state === 'working' ? 'running'
                  : mem.state === 'pending' ? 'queued'
                    : (mem.state === 'waiting' || mem.state === 'done' || mem.state === 'error' || mem.state === 'stopped' || mem.state === 'killed') ? mem.state
                      : null;
                if (idx >= 0) {
                  const cur = next[idx];
                  next[idx] = {
                    ...cur,
                    status: mapped || cur.status,
                    posts: mem.posts != null ? mem.posts : cur.posts,
                    model: mem.model || cur.model,
                  };
                } else {
                  next.push({
                    key: mem.name,
                    handle: mem.name,
                    name: mem.name,
                    status: mapped || 'queued',
                    role: mem.role || 'worker',
                    jobRole: mem.jobRole || null,
                    model: mem.model || null,
                    tier: mem.tier || null,
                    posts: mem.posts || 0,
                    startedAt: Date.now(),
                  });
                }
                return next;
              });
            }
          } else if (evt.phase === 'monitor') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'wakeup', wave: evt.wave || ((w && w.wave) || 0) + 1 }));
            const who = [...(evt.stalled || []), ...(evt.addressed || [])].filter((v, i, a) => a.indexOf(v) === i);
            if (who.length) setNotice(`Team monitor: re-briefing ${who.join(', ')} (${evt.stalled && evt.stalled.length ? 'no board report' : 'addressed on the board'}).`);
          } else if (evt.phase === 'dispatched') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'review' }));
          } else if (evt.phase === 'done') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'done', ms: evt.ms }));
          }
          break;
        }
        case 'artifact':
          setArtifactsExplicit((a) => [...a.filter((x) => x.name !== evt.name), { name: evt.name, language: evt.language, content: evt.content, path: evt.path }]);
          setNotice(`Artifact created: ${evt.name || evt.language || 'code'} (view in Artifacts panel)`);
          if (evt.path && /\.(html?|svg)$/i.test(evt.name || evt.path)) openPreview(evt.path);
          break;
        case 'preview':
          if (evt.url) openPreview(evt.url);
          break;
        case 'cwd':
          // The backend resolved the conversation's real project folder. Show it,
          // so the bar and the pane can never point at different directories.
          if (evt.dir) setCwd(evt.dir);
          break;
        case 'userMessage':
          setNotice(String(evt.text || ''));
          break;
        case 'goal':
          setGoal(String(evt.goal || ''));
          setNotice('Goal: ' + evt.goal);
          break;
        case 'usage':
          if (evt.usage) setLastUsage({ ...evt.usage, model: evt.model || (evt.usage && evt.usage.model) || null, at: Date.now() });
          if (evt.model) {
            setLiveSync((l) => (l ? { ...l, model: evt.model || l.model } : l));
          }
          break;
        case 'notice':
          // Context compaction and other system-level messages from the agent.
          setNotice(String(evt.text || ''));
          break;
        case 'limit':
          setNotice(`Paused after ${evt.steps} tool turns — the runaway safety valve, not a step limit. Say "continue" to carry on.`);
          break;
        case 'compliance':
          // Settings changed in another window (or via IPC) — re-render gates.
          if (evt.state) {
            setCompliance((prev) => ({ ...(prev || { profile: null, catalog: [] }), state: evt.state }));
          }
          break;
        case 'deeplink': {
          // Desktop's launcher.js routes claude:// links to app surfaces. We map
          // the equivalent helio:// forms: new chat, a specific conversation,
          // settings, search, and a prefilled prompt (`helio://ask?q=…`).
          // Unknown routes are ignored rather than erroring.
          const raw = String(evt.url || '');
          let u = null;
          try { u = new URL(raw); } catch (_) { u = null; }
          if (!u) break;
          const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
          const route = (u.hostname || parts.shift() || '').toLowerCase();
          const rest = parts[0] ? decodeURIComponent(parts[0]) : '';
          if (route === 'new' || route === 'chat') {
            if (rest) selectConv(rest); else newChat();
          } else if (route === 'search') {
            setPanel('search');
          } else if (route === 'settings') {
            setShowSettings(true);
          } else if (route === 'ask') {
            newChat();
            const q = u.searchParams.get('q') || u.searchParams.get('prompt') || '';
            if (q) setNotice(`Prompt loaded — press Enter to send: ${q}`);
            setTimeout(() => { const el = inputRef.current; if (el) { el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); } }, 60);
          }
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, []);
}