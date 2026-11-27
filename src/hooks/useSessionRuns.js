import { useState, useRef, useCallback, useMemo } from 'react';
import { uid } from '../utils/appHelpers.jsx';

export function emptySessionRun(convId, runId = null, initialLive = null) {
  return {
    convId,
    runId,
    active: true,
    streaming: true,
    paused: false,
    startedAt: Date.now(),
    thinking: '',
    live: initialLive,
    subAgents: [],
    swarmInfo: null,
    swarmBoard: [],
  };
}

/**
 * Pure helper to merge/commit one finished or cancelled run's streamed assistant
 * message into a conversation list. Exported for direct unit testing.
 */
export function buildCommittedAssistantMessage(run) {
  if (!run) return null;
  const l = run.live;
  const subAgents = Array.isArray(run.subAgents) ? run.subAgents : [];
  const hasTeam = subAgents.length > 0;
  if (!l || (!l.content && !(l.tools && l.tools.length) && !(l.checkpoints && l.checkpoints.length) && !hasTeam)) {
    return null;
  }
  const startedAt = Number(run.startedAt) || 0;
  return {
    id: uid(),
    role: 'assistant',
    content: l.content || '',
    tools: l.tools || [],
    segments: l.segments,
    checkpoints: l.checkpoints || [],
    checkpointId: l.checkpointId || null,
    model: l.model || '',
    autoRouted: l.autoRouted || undefined,
    modelsUsed: Array.isArray(l.modelsUsed) && l.modelsUsed.length ? l.modelsUsed : undefined,
    subAgents: hasTeam ? subAgents : undefined,
    swarmInfo: run.swarmInfo || undefined,
    ts: Date.now(),
    completedAt: Date.now(),
    durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
  };
}

/**
 * Manages concurrent per-conversation run states (`runsByConv`) so multiple sessions
 * can stream simultaneously while `+ New chat` and other idle tabs remain usable.
 */
export function useSessionRuns({ activeId, setConvs, setPermissionQueue, setQuestionQueue, setPermError, setScrolledAway }) {
  const [runsByConv, setRunsByConv] = useState({});
  const runsByConvRef = useRef({});
  const convByRunIdRef = useRef(new Map());

  const setRunsSync = useCallback((updater) => {
    const prev = runsByConvRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    runsByConvRef.current = next;
    setRunsByConv(next);
    return next;
  }, []);

  const resolveConvForEvent = useCallback((evt) => {
    if (!evt || typeof evt !== 'object') return null;
    if (evt.convId) return evt.convId;
    if (evt.runId && convByRunIdRef.current.has(evt.runId)) {
      return convByRunIdRef.current.get(evt.runId) || null;
    }
    return null;
  }, []);

  const isEventForLiveRun = useCallback((evt) => {
    if (!evt || !evt.runId) return true;
    const convId = resolveConvForEvent(evt);
    if (!convId) return true;
    const run = runsByConvRef.current[convId];
    if (!run) return false;
    return !run.runId || run.runId === evt.runId;
  }, [resolveConvForEvent]);

  const startSessionRun = useCallback((convId, runId, initialLive) => {
    if (!convId) return;
    if (runId) convByRunIdRef.current.set(runId, convId);
    const entry = emptySessionRun(convId, runId, initialLive);
    setRunsSync((prev) => ({ ...prev, [convId]: entry }));
  }, [setRunsSync]);

  const updateSessionRun = useCallback((convIdOrRunId, updater) => {
    if (!convIdOrRunId) return;
    setRunsSync((prev) => {
      const convId = prev[convIdOrRunId]
        ? convIdOrRunId
        : (convByRunIdRef.current.get(convIdOrRunId) || null);
      if (!convId || !prev[convId]) return prev;
      const cur = prev[convId];
      const nextEntry = typeof updater === 'function' ? updater(cur) : { ...cur, ...updater };
      if (!nextEntry || nextEntry === cur) return prev;
      return { ...prev, [convId]: nextEntry };
    });
  }, [setRunsSync]);

  const commitSessionLive = useCallback((convIdOrRunId, explicitRunId = null) => {
    const prevMap = runsByConvRef.current;
    const convId = (convIdOrRunId && prevMap[convIdOrRunId])
      ? convIdOrRunId
      : (explicitRunId && convByRunIdRef.current.get(explicitRunId))
        || (convIdOrRunId && convByRunIdRef.current.get(convIdOrRunId))
        || null;
    if (!convId) return null;
    const run = prevMap[convId];
    if (!run || !run.active) return null;
    if (explicitRunId && run.runId && run.runId !== explicitRunId) return null;

    const committedRun = run;
    const finishedRunId = run.runId;
    if (finishedRunId) convByRunIdRef.current.delete(finishedRunId);

    setRunsSync((prev) => {
      if (!prev[convId]) return prev;
      const copy = { ...prev };
      delete copy[convId];
      return copy;
    });

    if (setPermError) setPermError('');
    if (setScrolledAway && convId === activeId) setScrolledAway(false);
    if (setPermissionQueue && finishedRunId) {
      setPermissionQueue((q) => q.filter((p) => !p.runId || p.runId !== finishedRunId));
    }
    if (setQuestionQueue && finishedRunId) {
      setQuestionQueue((q) => q.filter((x) => !x.runId || x.runId !== finishedRunId));
    }

    const msg = buildCommittedAssistantMessage(committedRun);
    if (msg && setConvs) {
      const hasTeam = Array.isArray(committedRun.subAgents) && committedRun.subAgents.length > 0;
      setConvs((cs) => cs.map((c) => (c.id === convId ? {
        ...c,
        messages: [...c.messages, msg],
        ...(hasTeam ? {
          subAgents: committedRun.subAgents,
          swarmInfo: committedRun.swarmInfo || c.swarmInfo,
          swarmBoard: (committedRun.swarmBoard && committedRun.swarmBoard.length) ? committedRun.swarmBoard : c.swarmBoard,
        } : {}),
      } : c)));
    }
    return committedRun;
  }, [activeId, setConvs, setPermissionQueue, setQuestionQueue, setPermError, setScrolledAway, setRunsSync]);

  const activeRun = activeId ? (runsByConv[activeId] || null) : null;
  const streaming = Boolean(activeRun && activeRun.streaming);
  const paused = Boolean(activeRun && activeRun.paused);
  const runStartedAt = (activeRun && activeRun.startedAt) || 0;
  const thinking = (activeRun && activeRun.thinking) || '';
  const liveForActive = (activeRun && activeRun.live) || null;

  const streamingConvIds = useMemo(() => {
    const s = new Set();
    for (const [cid, r] of Object.entries(runsByConv)) {
      if (r && r.streaming) s.add(cid);
    }
    return s;
  }, [runsByConv]);

  const anyStreaming = streamingConvIds.size > 0;
  const streamingConvId = activeRun && activeRun.streaming
    ? activeId
    : (streamingConvIds.values().next().value || null);

  return {
    runsByConv,
    runsByConvRef,
    convByRunIdRef,
    activeRun,
    streaming,
    paused,
    runStartedAt,
    thinking,
    liveForActive,
    anyStreaming,
    streamingConvIds,
    streamingConvId,
    resolveConvForEvent,
    isEventForLiveRun,
    startSessionRun,
    updateSessionRun,
    commitSessionLive,
  };
}
