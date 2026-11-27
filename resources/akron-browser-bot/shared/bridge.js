/** Desktop bridge messages. Local socket is ws://127.0.0.1:8766. */

export const BRIDGE_URL = "ws://127.0.0.1:8766";
const BRIDGE_RETRY_MS = 20000;

/**
 * Keeps one socket open to the desktop bridge while it is enabled and retries
 * after it closes. While disabled it makes no connection attempt at all: with
 * nothing listening, the browser logs every attempt as an extension error.
 *
 * @param {object} options
 * @param {(url: string) => object} options.createSocket opens a WebSocket
 * @param {(event: object, socket: object) => void} options.onMessage
 * @returns {{ setEnabled(value: boolean): void }}
 */
export function createBridgeLink({
  url = BRIDGE_URL,
  createSocket,
  probeReachable,
  onMessage,
  onOpen,
  retryMs = BRIDGE_RETRY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let enabled = false;
  let socket = null;
  let retryTimer = null;
  let probing = false;

  const scheduleRetry = () => {
    if (!enabled || retryTimer) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      open();
    }, retryMs);
  };

  const open = async () => {
    if (!enabled || socket || probing) return;
    if (typeof probeReachable === "function") {
      probing = true;
      let reachable = false;
      try {
        reachable = !!(await probeReachable(url));
      } catch {
        reachable = false;
      } finally {
        probing = false;
      }
      if (!enabled || socket) return;
      if (!reachable) {
        scheduleRetry();
        return;
      }
    }
    let next;
    try {
      next = createSocket(url);
    } catch {
      scheduleRetry();
      return;
    }
    socket = next;
    next.onopen = () => {
      if (typeof onOpen === "function") {
        try { onOpen(next); } catch {}
      }
    };
    next.onmessage = (event) => onMessage(event, next);
    next.onerror = () => {};
    next.onclose = () => {
      if (socket === next) socket = null;
      scheduleRetry();
    };
  };

  return {
    send(payload) {
      if (!socket || socket.readyState !== 1) return false;
      try {
        socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    },
    setEnabled(value) {
      const wanted = !!value;
      if (wanted === enabled) return;
      enabled = wanted;
      if (enabled) {
        open();
        return;
      }
      if (retryTimer) {
        clearTimer(retryTimer);
        retryTimer = null;
      }
      const current = socket;
      socket = null;
      if (current) {
        try {
          current.close();
        } catch {}
      }
    },
  };
}

export function createBridgeHost({ skills = [], onPair, onTask } = {}) {
  const library = [...skills];
  return {
    skills: library,
    async receive(message) {
      const type = message?.type;
      if (type === "ping") return [{ type: "pong" }];
      if (type === "pairing_request") {
        const accepted = onPair ? await onPair(message) : true;
        return [
          accepted
            ? {
                type: "pairing_response",
                request_id: message.request_id,
                device_id: "autobot",
                name: message.name || "Akron",
              }
            : { type: "pairing_response", request_id: message.request_id, dismissed: true },
        ];
      }
      if (type === "skill_list") {
        return [{ type: "skill_list_result", request_id: message.request_id, skills: library.map(publicSkill) }];
      }
      if (type === "skill_get") {
        const skill = library.find((item) => item.id === message.id || item.name === message.name);
        return [{ type: "skill_get_result", request_id: message.request_id, skill: skill ? publicSkill(skill) : null }];
      }
      if (type === "skill_put") {
        const skill = {
          id: message.skill?.id || `skill_${Date.now()}`,
          name: message.skill?.name || "Untitled skill",
          description: message.skill?.description || "",
          instructions: message.skill?.instructions || "",
          enabled: message.skill?.enabled !== false,
        };
        const index = library.findIndex((item) => item.id === skill.id);
        if (index >= 0) library[index] = skill;
        else library.push(skill);
        return [{ type: "skill_put_result", request_id: message.request_id, skill: publicSkill(skill) }];
      }
      if (type === "skill_delete") {
        const before = library.length;
        for (let i = library.length - 1; i >= 0; i--) {
          if (library[i].id === message.id) library.splice(i, 1);
        }
        return [{ type: "skill_delete_result", request_id: message.request_id, deleted: library.length !== before }];
      }
      if (type === "run_task") {
        const events = onTask ? await onTask(message) : [{ type: "assistant_final", text: "ok" }];
        return [{ type: "task_accepted", request_id: message.request_id }, ...events];
      }
      if (type === "settings_get") {
        return [{ type: "settings_result", request_id: message.request_id, settings: message.settings || {} }];
      }
      return [{ type: "error", request_id: message.request_id, message: "Unknown message" }];
    },
  };
}

function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: skill.enabled !== false,
  };
}
