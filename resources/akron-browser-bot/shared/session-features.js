/** Local equivalents of 1.0.107 session behaviors. No network. */

import { isLocalBaseUrl } from "./presets.js";

// How much conversation text goes to the model before anything is cut. About
// four characters make a token, so this is roughly 60k tokens: room for a long
// task, and inside the context window of every current hosted model.
export const CONTEXT_BUDGET_CHARS = 240000;
// A model running on this computer often has only a few thousand tokens.
export const LOCAL_CONTEXT_BUDGET_CHARS = 24000;
// Page reads kept whole may take this share of the budget; older ones keep
// their beginning.
export const FULL_RESULTS_SHARE = 0.4;
const OLD_RESULT_CHARS = 2000;
const TRIM_NOTE_ROOM = 300;
const SUMMARY_MESSAGE_CHARS = 3000;

/** The budget for a pool of endpoints: the small one if any of them is local. */
export function contextBudget(pool) {
  const hasLocal = (pool || []).some((endpoint) => isLocalBaseUrl(endpoint?.providerConfig?.baseUrl));
  return hasLocal ? LOCAL_CONTEXT_BUDGET_CHARS : CONTEXT_BUDGET_CHARS;
}

export function conversationSize(messages) {
  return (messages || []).reduce((sum, message) => {
    const content = typeof message?.content === "string" ? message.content : "";
    return sum + content.length;
  }, 0);
}

export function shouldCompact(messages, { minMessages = 12, minChars = CONTEXT_BUDGET_CHARS } = {}) {
  const list = messages || [];
  return list.length >= minMessages && conversationSize(list) >= minChars;
}

/**
 * Cuts older tool results down to their beginning. The newest results stay
 * whole, up to `keepFullChars` in all (the very newest always does). Nothing
 * else changes: every step, call and result keeps its place, so the model still
 * sees what it did and in what order.
 * @returns {{ messages: object[], changed: boolean }} a new list when something was cut
 */
export function trimOldToolResults(
  messages,
  { keepFullChars = CONTEXT_BUDGET_CHARS * FULL_RESULTS_SHARE, keepChars = OLD_RESULT_CHARS } = {}
) {
  const list = messages || [];
  const out = [...list];
  let whole = 0;
  let newest = true;
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== "tool" || typeof message.content !== "string") continue;
    const size = message.content.length;
    if (newest || whole + size <= keepFullChars) {
      whole += size;
      newest = false;
      continue;
    }
    if (size <= keepChars + TRIM_NOTE_ROOM) continue;
    const note = `[${size - keepChars} more characters of this older result were dropped to save space. Read the page again if you need them.]`;
    out[i] = { ...message, content: `${message.content.slice(0, keepChars)}\n${note}` };
    changed = true;
  }
  return { messages: changed ? out : list, changed };
}

function describeForSummary(message) {
  const content = typeof message?.content === "string" ? message.content : "";
  const text = content.slice(0, SUMMARY_MESSAGE_CHARS);
  if (message?.role === "tool") return `result of ${message.name || "tool"}: ${text}`;
  const calls = (message?.toolCalls || []).map(
    (call) => `${call.name}(${JSON.stringify(call.args || {}).slice(0, 300)})`
  );
  return `${message?.role || "note"}: ${text}${calls.length ? ` [called ${calls.join(", ")}]` : ""}`;
}

export function messagesForSummary(messages) {
  const list = messages || [];
  const older = list.slice(0, Math.max(0, list.length - 4));
  return older.map(describeForSummary).join("\n");
}

function hasAllResults(messages, index) {
  const calls = messages[index]?.toolCalls || [];
  if (!calls.length) return true;
  const ids = new Set(calls.map((call) => call.id));
  for (let i = index + 1; i < messages.length && messages[i]?.role === "tool"; i++) {
    ids.delete(messages[i].toolCallId);
  }
  return ids.size === 0;
}

function sanitizeRecent(recent) {
  // OpenAI-compatible APIs reject a tool result that has no preceding
  // assistant tool_calls (and vice versa). A blind last-N slice can create
  // exactly that, which showed up as "request rejected" after compaction.
  while (recent.length) {
    const first = recent[0];
    if (first?.role === "tool") {
      recent.shift();
      continue;
    }
    if (
      first?.role === "assistant" &&
      Array.isArray(first.toolCalls) &&
      first.toolCalls.length &&
      !hasAllResults(recent, 0)
    ) {
      recent.shift();
      continue;
    }
    break;
  }

  while (recent.length) {
    const last = recent[recent.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length) {
      recent.pop();
      continue;
    }
    if (last?.role === "tool") {
      const id = last.toolCallId;
      let found = false;
      for (let i = recent.length - 2; i >= 0; i--) {
        const message = recent[i];
        if (
          message?.role === "assistant" &&
          (message.toolCalls || []).some((call) => call.id === id)
        ) {
          found = true;
          break;
        }
        if (message?.role === "assistant" || message?.role === "user") break;
      }
      if (!found) {
        recent.pop();
        continue;
      }
    }
    break;
  }
  return recent;
}

const TASK_LIMIT = 4000;

/**
 * The request the agent is working on, in the user's own words: the latest
 * message the user wrote, or the one carried over by an earlier compaction.
 * Screenshots and summaries that Akron adds itself are marked `auto`.
 */
export function currentTask(messages) {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (message?.role !== "user") continue;
    if (!message.auto) return String(message.content || "").slice(0, TASK_LIMIT);
    if (typeof message.task === "string" && message.task) return message.task;
  }
  return "";
}

// Starts the summary that stands in for the older part of a long chat. The
// panel knows that message by it: it is Akron's note to the model, not
// something the user said.
export const SUMMARY_MARK = "Conversation summary so we can keep chatting:";

export function applyCompaction(messages, summary) {
  const list = messages || [];
  const recent = sanitizeRecent(list.slice(-4));
  // A summary can leave the goal out. Keep the user's own request word for
  // word, unless it is still among the recent messages.
  const task = currentTask(list);
  const keepTask = task && !recent.some((message) => message?.role === "user" && !message.auto);
  const head = keepTask ? `The task you are working on, in the user's words:\n${task}\n\n` : "";
  return [
    {
      role: "user",
      content: `${head}${SUMMARY_MARK}\n${String(summary || "").trim()}`,
      auto: true,
      ...(task ? { task } : {}),
    },
    ...recent,
  ];
}

export function formatTaughtWorkflow(steps, narration) {
  const lines = ["Repeat this workflow:"];
  (steps || []).forEach((step, index) => {
    const action = step.action || "act";
    const detail = [step.text, step.name, step.url].filter(Boolean).join(" — ");
    lines.push(`${index + 1}. ${action}${detail ? `: ${detail}` : ""}`);
  });
  const spoken = String(narration || "").trim();
  if (spoken) {
    lines.push("");
    lines.push(`Narration: ${spoken}`);
  }
  return lines.join("\n");
}

export function filterConsoleLines(lines, { pattern, onlyErrors, limit = 100 } = {}) {
  let rows = Array.isArray(lines) ? lines.slice() : [];
  if (onlyErrors) rows = rows.filter((row) => /error|exception/i.test(`${row.level || ""} ${row.text || row}`));
  if (pattern) {
    let expression;
    try {
      expression = new RegExp(pattern, "i");
    } catch {
      return { error: "pattern is not a valid regular expression" };
    }
    rows = rows.filter((row) => expression.test(String(row.text || row)));
  }
  return { rows: rows.slice(-Math.max(1, Number(limit) || 100)) };
}
