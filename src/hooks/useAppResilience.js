import { useEffect, useRef } from 'react';
import { saveConvsJSON } from '../utils/appHelpers.jsx';

// A window reload (Cmd+R, View > Reload) wipes the renderer's run state while
// the main process keeps working; without this the reply was dropped and the
// queue started a second run on the same chat. Re-attach to runs still going.
export function useReattachRuns({ startSessionRun, runsByConvRef }) {
  useEffect(() => {
    if (!window.autobot || typeof window.autobot.activeRuns !== 'function') return;
    window.autobot.activeRuns().then((list) => {
      for (const r of Array.isArray(list) ? list : []) {
        if (!r || !r.runId || !r.convId) continue;
        const cur = runsByConvRef.current && runsByConvRef.current[r.convId];
        if (cur && cur.runId === r.runId) continue;
        startSessionRun(r.convId, r.runId, { content: '', tools: [], model: '' });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per window load
  }, []);
}

// Chats are one localStorage entry: save in full, else a trimmed copy, and tell
// the user once instead of failing silently (see saveConvsJSON).
export function usePersistConvs(convs, setNotice) {
  const warnedRef = useRef('');
  useEffect(() => {
    const r = saveConvsJSON('autobot:convs', convs);
    const state = !r.ok ? 'failed' : (r.compacted ? 'compacted' : '');
    if (state && warnedRef.current !== state) {
      warnedRef.current = state;
      setNotice(state === 'failed'
        ? 'Chats could not be saved: app storage is full. Delete or export large chats to keep new messages.'
        : 'Storage is nearly full: large images and outputs in older messages were trimmed so your chats keep saving.');
    } else if (!state) warnedRef.current = '';
  }, [convs, setNotice]);
}
