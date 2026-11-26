// Approval requests that are waiting for the user.
//
// Several tabs can have a task running at once, and the user only looks at one
// of them. A request therefore stays pending until someone answers it, and it
// can be shown again when the user comes back to that tab. The auto-decline
// countdown only runs while a panel is showing the request's chat, so a task on
// a tab the user is not looking at waits instead of being declined unseen.

export const CONFIRM_TIMEOUT_MS = 180000;

/**
 * @param {object} [options]
 * @param {number} [options.timeoutMs] how long a visible prompt may go unanswered
 * @returns {{
 *   add(sessionId: string, payload: object): { id: string, request: object, promise: Promise<object> },
 *   answer(id: string, decision: object): boolean,
 *   declineSession(sessionId: string): void,
 *   requestsFor(sessionId: string): object[],
 *   setVisible(sessionId: string, visible: boolean): void,
 * }}
 */
export function createConfirmQueue({
  timeoutMs = CONFIRM_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const pending = new Map(); // id -> { sessionId, request, resolve, timer }
  let counter = 0;

  const stopTimer = (entry) => {
    if (entry.timer == null) return;
    clearTimer(entry.timer);
    entry.timer = null;
  };

  const settle = (id, decision) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    stopTimer(entry);
    entry.resolve(decision);
    return true;
  };

  return {
    add(sessionId, payload) {
      counter += 1;
      const id = `c${Date.now()}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const request = { type: "confirm_request", id, ...payload };
      const promise = new Promise((resolve) => {
        pending.set(id, { sessionId, request, resolve, timer: null });
      });
      return { id, request, promise };
    },

    answer: settle,

    declineSession(sessionId) {
      for (const [id, entry] of [...pending]) {
        if (entry.sessionId === sessionId) settle(id, { approved: false });
      }
    },

    requestsFor(sessionId) {
      return [...pending.values()]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.request);
    },

    setVisible(sessionId, visible) {
      for (const [id, entry] of pending) {
        if (entry.sessionId !== sessionId) continue;
        if (!visible) {
          stopTimer(entry);
          continue;
        }
        if (entry.timer != null) continue;
        entry.timer = setTimer(() => {
          entry.timer = null;
          settle(id, { approved: false });
        }, timeoutMs);
      }
    },
  };
}
