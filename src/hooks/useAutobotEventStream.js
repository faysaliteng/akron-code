import { useEffect } from 'react';
import { summarizeChangedFiles } from '../components/LiveProgress.jsx';
import { uid, cleanErr, sendDesktopNotification, usedTokens, recordConvUsage, buildLocalCompactDigest } from '../utils/appHelpers.jsx';

export function useAutobotEventStream({
  runsByConvRef, resolveConvForEvent, isEventForLiveRun, updateSessionRun, commitSessionLive,
  activeIdRef, settingsRef,
  setPermError, setPermissionQueue, setLastUsage,
  setError, setModelMenuOpen, setQuestionQueue,
  setShowSettings, setPanel, setActiveId, setConvs, setCuConsent,
  setPermissions, setPlanMode, setArtifactsExplicit, setNotice, setFeatures, setOrchestrator,
  openPreview, setCwd, setGoal, setCompliance, selectConv, newChat, inputRef,
}) {
  useEffect(() => {
    const off = window.autobot.onEvent((evt) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.runId && !isEventForLiveRun(evt)
        && /^(delta|thinking|tool|toolStream|toolResult|done|complete|cancelled|error|notice|limit|retry|usage|subagent|swarm|paused)$/.test(evt.type)) {
        return;
      }

      const resolvedConv = resolveConvForEvent(evt);
      // Never fall back to activeIdRef.current for run-scoped events — otherwise clicking
      // "+ New chat" (activeId=null) or switching to Tab B routes stray events onto the wrong tab.
      const targetConv = resolvedConv || (!evt.runId ? (activeIdRef.current || null) : null);
      const runSnap = targetConv ? (runsByConvRef.current[targetConv] || null) : null;
      const runRefKey = targetConv || evt.runId || null;

      const patchLive = (fn) => {
        if (!runRefKey) return;
        updateSessionRun(runRefKey, (r) => {
          const prevLive = r.live || { content: '', tools: [], segments: [] };
          const nextLive = typeof fn === 'function' ? fn(prevLive) : fn;
          return { ...r, live: nextLive };
        });
      };

      const subTag = evt.subagent != null ? String(evt.subagent) : (evt.agentId != null ? String(evt.agentId) : '');
      if (subTag && evt.type === 'checkpoint') {
        const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
        patchLive((l) => ({ ...l, checkpointId: cp.id, checkpoints: [...(l.checkpoints || []), cp] }));
        return;
      }
      if (subTag && !/^(question|plan|permission|computerUseConsent|permissionMode|planMode|artifact|preview|subagent|swarm|cwd|deeplink|compliance)$/.test(evt.type)) {
        const agentKey = evt.agentId != null ? String(evt.agentId) : '';
        const normHandle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        if (runRefKey) {
          updateSessionRun(runRefKey, (r) => ({
            ...r,
            subAgents: (r.subAgents || []).map((a) => {
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
                  const seen = evt.id ? (p.log || []).findIndex((e) => e.id === evt.id) : -1;
                  if (seen >= 0) {
                    // Second announcement of the same call: fill in its argument only.
                    if (!shortArg) return a;
                    const log = (p.log || []).slice();
                    log[seen] = { ...log[seen], arg: shortArg };
                    return { ...a, progress: { ...p, currentTool: { name: evt.name, arg: shortArg }, log } };
                  }
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
                default: return a;
              }
            }),
          }));
        }
        return;
      }

      switch (evt.type) {
        case 'retry':
          patchLive((l) => {
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
          if (runRefKey) {
            updateSessionRun(runRefKey, (r) => {
              const base = r.live || { content: '', tools: [], segments: [] };
              const segments = (base.segments || []).slice();
              const last = segments[segments.length - 1];
              if (last && last.type === 'text') segments[segments.length - 1] = { type: 'text', text: last.text + evt.text };
              else segments.push({ type: 'text', text: evt.text });
              return { ...r, thinking: '', live: { ...base, content: base.content + evt.text, segments, streamingTool: null } };
            });
          }
          break;
        case 'thinking':
          if (runRefKey) {
            updateSessionRun(runRefKey, (r) => {
              const base = r.live || { content: '', tools: [], segments: [] };
              const segments = (base.segments || []).slice();
              const last = segments[segments.length - 1];
              const GROW = 12000;
              if (last && last.type === 'thinking') {
                const merged = last.text + evt.text;
                segments[segments.length - 1] = { type: 'thinking', text: merged.length > GROW ? merged.slice(-GROW) : merged };
              } else {
                segments.push({ type: 'thinking', text: evt.text });
              }
              return { ...r, thinking: (r.thinking || '') + evt.text, live: { ...base, segments } };
            });
          }
          break;
        case 'toolStream':
          patchLive((base) => {
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
        case 'tool': {
          const tid = evt.id || uid();
          patchLive((base) => {
            // CLI providers announce a call twice: when it starts (no args yet)
            // and again with the full arguments. Same id -> same row.
            if (evt.id && (base.tools || []).some((t) => t.id === evt.id)) {
              const hasArgs = evt.args && typeof evt.args === 'object' && Object.keys(evt.args).length > 0;
              if (!hasArgs) return base;
              return { ...base, tools: base.tools.map((t) => (t.id === evt.id ? { ...t, args: evt.args } : t)) };
            }
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
          if (runRefKey) updateSessionRun(runRefKey, (r) => ({ ...r, paused: !!evt.paused }));
          break;
        case 'toolResult':
          patchLive((l) => ({
            ...l,
            tools: (l.tools || []).map((t) => (t.id === evt.id ? { ...t, result: evt.result, status: evt.isError ? 'error' : 'done' } : t)),
          }));
          break;
        case 'done':
        case 'complete': {
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          if (evt && evt.usage) {
            setLastUsage((prev) => {
              const incomingCtx = usedTokens(evt.usage);
              const prevCtx = (prev && (!prev.convId || prev.convId === targetConv)) ? usedTokens(prev) : 0;
              const next = {
                ...(incomingCtx <= 0 && prevCtx > 0 ? prev : {}),
                ...evt.usage,
                ...(incomingCtx <= 0 && prevCtx > 0 ? { context_tokens: prevCtx, prompt_tokens: Math.max(Number(evt.usage.prompt_tokens) || 0, Number(prev.prompt_tokens) || 0) } : {}),
                model: evt.usage.model || evt.model || (prev && prev.model) || null,
                convId: targetConv,
                at: Date.now(),
              };
              recordConvUsage(targetConv, next);
              return next;
            });
          }
          const snapTools = (runSnap && runSnap.live && runSnap.live.tools) || [];
          const snapCps = (runSnap && runSnap.live && runSnap.live.checkpoints) || [];
          const elapsedSec = (runSnap && runSnap.startedAt) ? Math.max(1, Math.round((Date.now() - runSnap.startedAt) / 1000)) : 0;
          const touched = summarizeChangedFiles(snapTools, snapCps).files.length;
          const summaryBits = [
            elapsedSec ? `Finished in ${elapsedSec}s` : 'Agent finished working in your workspace',
            touched > 0 ? `${touched} file${touched === 1 ? '' : 's'} updated` : '',
          ].filter(Boolean);
          const committed = commitSessionLive(targetConv, evt.runId);
          if (committed) {
            sendDesktopNotification('agent', 'Akron Code', summaryBits.join(' · ') + '.', settingsRef.current, { convId: targetConv });
          }
          break;
        }
        case 'cancelled':
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          commitSessionLive(targetConv, evt.runId);
          break;
        case 'error':
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          setQuestionQueue((q) => q.filter((x) => evt.runId && x.runId && x.runId !== evt.runId));
          commitSessionLive(targetConv, evt.runId, cleanErr(evt.message));
          if (!targetConv || targetConv === activeIdRef.current) setError(cleanErr(evt.message));
          else setNotice(`${cleanErr(evt.message)}`);
          sendDesktopNotification('errors', 'Akron Code · Error', cleanErr(evt.message), settingsRef.current, { convId: targetConv });
          if (evt.needsSignIn) setModelMenuOpen(true);
          break;
        case 'question': {
          const item = {
            id: evt.id,
            runId: evt.runId || (runSnap && runSnap.runId) || null,
            convId: targetConv,
            type: 'question',
            text: evt.question,
            questions: Array.isArray(evt.questions) && evt.questions.length ? evt.questions : null,
            options: evt.options || [],
          };
          setQuestionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('questions', 'Akron Code needs input', evt.question, settingsRef.current, { convId: targetConv });
          break;
        }
        case 'plan': {
          const item = {
            id: evt.id,
            runId: evt.runId || (runSnap && runSnap.runId) || null,
            convId: targetConv,
            type: 'plan',
            text: evt.plan,
            allowedPrompts: evt.allowedPrompts || [],
            options: [],
          };
          setQuestionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('questions', 'Akron Code · Plan approval', 'Review proposed execution plan.', settingsRef.current, { convId: targetConv });
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
            runId: evt.runId || (runSnap && runSnap.runId) || null,
            convId: targetConv,
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
          setCuConsent({ id: evt.id, tier: evt.tier || 'access', tool: evt.tool || '', sensitive: !!evt.sensitive });
          sendDesktopNotification('permissions', 'Computer Use approval needed', `Allow ${evt.tier || 'access'} for ${evt.tool || 'desktop action'}?`, settingsRef.current, { convId: targetConv });
          break;
        case 'permissionMode':
          if (evt.mode) setPermissions(evt.mode);
          break;
        case 'planMode':
          // The banner belongs to the chat on screen, not to one running in the background.
          if (!targetConv || targetConv === activeIdRef.current) setPlanMode(evt.active ? { active: true, file: evt.file || 'PLAN.md' } : null);
          break;
        case 'orchestrator':
          if (evt.orchestrator && typeof setOrchestrator === 'function') {
            setOrchestrator(evt.orchestrator);
            try { localStorage.setItem('autobot:orchestrator', JSON.stringify(evt.orchestrator)); } catch (_) {}
          } else {
            patchLive((l) => (l ? { ...l, failover: { from: evt.from, to: evt.to, reason: evt.reason }, model: evt.to || l.model } : l));
          }
          break;
        case 'model':
          if (evt.model) {
            setLastUsage((u) => {
              const sameConv = !u || !u.convId || u.convId === targetConv;
              return { ...(sameConv && u ? u : {}), model: evt.model, convId: targetConv, at: (sameConv && u && u.at) || Date.now() };
            });
          }
          patchLive((l) => (l ? {
            ...l,
            model: evt.model || l.model || '',
            autoRouted: evt.autoRouted || l.autoRouted || null,
            modelsUsed: Array.isArray(evt.modelsUsed) && evt.modelsUsed.length ? evt.modelsUsed : l.modelsUsed,
          } : l));
          break;
        case 'checkpoint': {
          const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
          patchLive((base) => ({ ...base, checkpointId: cp.id, checkpoints: [...(base.checkpoints || []), cp] }));
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
          if (runRefKey) {
            updateSessionRun(runRefKey, (r) => {
              if ((key === 'supervisor' || evt.role === 'supervisor') && r.swarmInfo) {
                return {
                  ...r,
                  swarmInfo: {
                    ...r.swarmInfo,
                    supervisorState: status,
                    supervisor: { ...(r.swarmInfo.supervisor || {}), model: evt.model || (r.swarmInfo.supervisor && r.swarmInfo.supervisor.model) },
                  },
                };
              }
              const next = [...(r.subAgents || [])];
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
              return { ...r, subAgents: next };
            });
          }
          if (evt.background && (status === 'done' || status === 'error')) {
            sendDesktopNotification(
              status === 'error' ? 'errors' : 'agent',
              status === 'error' ? 'Akron Code · Background agent error' : 'Akron Code · Background agent complete',
              `${evt.name || 'Sub-agent'} ${status === 'error' ? 'failed' : 'finished'}.`,
              settingsRef.current,
              { convId: targetConv }
            );
          }
          break;
        }
        case 'swarm': {
          if (!runRefKey) break;
          updateSessionRun(runRefKey, (r) => {
            if (evt.phase === 'start') {
              return {
                ...r,
                swarmInfo: { supervisor: evt.supervisor, roster: evt.roster || [], pools: !!evt.pools, phase: 'planning', wave: 0, startedAt: Date.now() },
                swarmBoard: [],
              };
            }
            if (evt.phase === 'planned') {
              const byKey = new Map((r.subAgents || []).map((a) => [a.key, a]));
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
              return { ...r, swarmInfo: { ...(r.swarmInfo || {}), phase: 'dispatch', taskCount: (evt.tasks || []).length }, subAgents: [...byKey.values()] };
            }
            if (evt.phase === 'board' && evt.msg) {
              const prev = r.swarmBoard || [];
              if (prev.some((m) => m.seq === evt.msg.seq)) return r;
              return { ...r, swarmBoard: [...prev, evt.msg].slice(-200) };
            }
            if (evt.phase === 'member' && evt.member) {
              const mem = evt.member;
              if (mem.name === 'supervisor') {
                return { ...r, swarmInfo: { ...(r.swarmInfo || {}), supervisorState: mem.state, phase: mem.state === 'reviewing' ? 'review' : (r.swarmInfo && r.swarmInfo.phase) } };
              }
              const next = [...(r.subAgents || [])];
              const idx = next.findIndex((a) => a.handle === mem.name || a.key === mem.name || a.name === mem.name);
              const mapped = mem.state === 'working' ? 'running'
                : mem.state === 'pending' ? 'queued'
                  : (mem.state === 'waiting' || mem.state === 'done' || mem.state === 'error' || mem.state === 'stopped' || mem.state === 'killed') ? mem.state
                    : null;
              if (idx >= 0) {
                const cur = next[idx];
                next[idx] = { ...cur, status: mapped || cur.status, posts: mem.posts != null ? mem.posts : cur.posts, model: mem.model || cur.model };
              } else {
                next.push({
                  key: mem.name, handle: mem.name, name: mem.name, status: mapped || 'queued',
                  role: mem.role || 'worker', jobRole: mem.jobRole || null, model: mem.model || null,
                  tier: mem.tier || null, posts: mem.posts || 0, startedAt: Date.now(),
                });
              }
              return { ...r, subAgents: next };
            }
            if (evt.phase === 'monitor') {
              return { ...r, swarmInfo: { ...(r.swarmInfo || {}), phase: 'wakeup', wave: evt.wave || ((r.swarmInfo && r.swarmInfo.wave) || 0) + 1 } };
            }
            if (evt.phase === 'dispatched') {
              let nextAgents = r.subAgents || [];
              if (Array.isArray(evt.results) && evt.results.length) {
                const resMap = new Map(evt.results.map((x) => [String(x.id || x.title || ''), x]));
                nextAgents = nextAgents.map((a) => {
                  const hit = resMap.get(String(a.key || '')) || resMap.get(String(a.name || ''));
                  if (!hit) return a;
                  const st = hit.status === 'done' ? 'done'
                    : (hit.status === 'error' ? 'error' : (hit.status === 'killed' ? 'killed' : (hit.status === 'stopped' ? 'stopped' : a.status)));
                  return { ...a, status: st, model: hit.model || a.model, ms: hit.ms != null ? hit.ms : a.ms };
                });
              }
              return { ...r, swarmInfo: { ...(r.swarmInfo || {}), phase: 'review' }, subAgents: nextAgents };
            }
            if (evt.phase === 'done') {
              return { ...r, swarmInfo: { ...(r.swarmInfo || {}), phase: 'done', ms: evt.ms } };
            }
            return r;
          });
          if (evt.phase === 'monitor') {
            const who = [...(evt.stalled || []), ...(evt.addressed || [])].filter((v, i, a) => a.indexOf(v) === i);
            if (who.length) setNotice(`Team monitor: re-briefing ${who.join(', ')} (${evt.stalled && evt.stalled.length ? 'no board report' : 'addressed on the board'}).`);
          }
          break;
        }
        case 'artifact':
          setArtifactsExplicit((a) => [...a.filter((x) => x.name !== evt.name), { name: evt.name, language: evt.language, content: evt.content, path: evt.path }]);
          setNotice(`Artifact created: ${evt.name || evt.language || 'code'} (view in Artifacts panel)`);
          if (evt.path && /\.html?$/i.test(evt.name || evt.path) && (!targetConv || targetConv === activeIdRef.current)) {
            openPreview(evt.path, { newTab: true, artifactPreview: true });
          }
          break;
        case 'preview':
          if (evt.url && (!targetConv || targetConv === activeIdRef.current)) openPreview(evt.url, { newTab: !!evt.newTab });
          break;
        case 'cwd':
          if (evt.dir) {
            if (targetConv) {
              try { localStorage.setItem('autobot:workspace:' + targetConv, JSON.stringify(evt.dir)); } catch (_) {}
            }
            if (!targetConv || targetConv === activeIdRef.current) setCwd(evt.dir);
          }
          break;
        case 'userMessage':
          setNotice(String(evt.text || ''));
          break;
        case 'goal':
          setGoal(String(evt.goal || ''));
          setNotice('Goal: ' + evt.goal);
          break;
        case 'auto-compact': {
          const acMeta = {
            beforeTokens: Number(evt.beforeTokens) || 0,
            afterTokens: Number(evt.afterTokens) || 0,
            contextWindow: Number(evt.contextWindow) || 0,
            dropped: Number(evt.dropped) || 0,
            trigger: evt.trigger || 'auto',
            at: Number(evt.at) || Date.now(),
          };
          setLastUsage((prev) => {
            const sameConv = !prev || !prev.convId || prev.convId === targetConv;
            const next = {
              ...(sameConv && prev ? prev : {}),
              context_tokens: acMeta.afterTokens > 0 ? acMeta.afterTokens : 1,
              prompt_tokens: acMeta.afterTokens > 0 ? acMeta.afterTokens : 1,
              compacted: true,
              lastAutoCompact: acMeta,
              model: evt.model || (sameConv && prev && prev.model) || null,
              convId: targetConv,
              at: acMeta.at,
            };
            recordConvUsage(targetConv, next);
            return next;
          });
          if (targetConv && typeof setConvs === 'function') {
            setConvs((cs) => cs.map((c) => {
              if (c.id !== targetConv) return c;
              const msgs = Array.isArray(c.messages) ? c.messages : [];
              if (msgs.length >= 3) {
                const dig = buildLocalCompactDigest(msgs, 2, acMeta.contextWindow || 1000000);
                if (dig.droppedCount > 0) {
                  return {
                    ...c,
                    messages: dig.messages,
                    archivedMessages: [...(c.archivedMessages || []), ...msgs.slice(0, Math.max(0, msgs.length - 2))].slice(-400),
                    compactedAt: acMeta.at,
                    lastAutoCompact: acMeta,
                  };
                }
              }
              return { ...c, compactedAt: acMeta.at, lastAutoCompact: acMeta };
            }));
          }
          break;
        }
        case 'usage':
          if (evt.usage) {
            setLastUsage((prev) => {
              const incomingCtx = usedTokens(evt.usage);
              const prevCtx = (prev && (!prev.convId || prev.convId === targetConv)) ? usedTokens(prev) : 0;
              const isPostCompact = Boolean(evt.usage.compacted);
              const keepPrevCtx = !isPostCompact && ((evt.subrun && prevCtx > 0) || (incomingCtx <= 0 && prevCtx > 0));
              const effCtx = isPostCompact
                ? incomingCtx
                : (evt.subrun ? Math.max(incomingCtx, prevCtx) : (incomingCtx > 0 ? incomingCtx : prevCtx));
              const next = {
                ...(keepPrevCtx && prev ? prev : {}),
                ...evt.usage,
                ...(effCtx > 0 ? { context_tokens: effCtx } : {}),
                lastAutoCompact: evt.usage.lastAutoCompact || (prev && prev.lastAutoCompact) || undefined,
                model: evt.subrun && prev && prev.model ? prev.model : (evt.model || (evt.usage && evt.usage.model) || (prev && prev.model) || null),
                convId: targetConv,
                at: Date.now(),
              };
              recordConvUsage(targetConv, next);
              return next;
            });
          }
          if (evt.model) patchLive((l) => (l ? { ...l, model: evt.model || l.model } : l));
          break;
        case 'notice':
          setNotice(String(evt.text || ''));
          break;
        case 'scheduled-session':
          if (evt.conversation && evt.conversation.id && typeof setConvs === 'function') {
            setConvs((cs) => [evt.conversation, ...(Array.isArray(cs) ? cs : []).filter((c) => c.id !== evt.conversation.id)]);
          }
          break;
        case 'limit':
          setNotice(`Paused after ${evt.steps} tool turns — the runaway safety valve, not a step limit. Say "continue" to carry on.`);
          break;
        case 'compliance':
          if (evt.state) setCompliance((prev) => ({ ...(prev || { profile: null, catalog: [] }), state: evt.state }));
          break;
        case 'features':
          if (evt.features && typeof setFeatures === 'function') {
            setFeatures(evt.features);
            try { localStorage.setItem('autobot:features', JSON.stringify(evt.features)); } catch (_) {}
          }
          break;
        case 'deeplink': {
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
