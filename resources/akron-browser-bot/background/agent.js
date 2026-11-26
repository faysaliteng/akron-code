import { createProvider, isProviderError } from "./providers.js";
import { buildSystemPrompt } from "./prompts.js";
import { TOOL_DEFS, executeTool } from "./tools.js";
import {
  MAX_TRANSIENT_RETRIES,
  cooldownRemaining,
  describeError,
  isTransientFailure,
  markFailure,
  markSuccess,
  orderEndpoints,
  transientCooldownRemaining,
  transientRetryDelay,
} from "./orchestrator.js";
import {
  FULL_RESULTS_SHARE,
  applyCompaction,
  contextBudget,
  conversationSize,
  messagesForSummary,
  shouldCompact,
  trimOldToolResults,
} from "../shared/session-features.js";
import { thinkingPreview } from "../shared/step-labels.js";
import { tabContextBlock } from "../shared/tab-context.js";
import {
  addResult,
  answerWithResults,
  cleanResults,
  hasUnshownResults,
  markResultsShown,
  resultsForModel,
} from "../shared/results.js";

// How often the panel is sent the model's current thinking.
const THINKING_UPDATE_MS = 250;

// A summary is an extra model call. It must never hold a task up: after this
// long the task goes on without it.
const SUMMARY_TIMEOUT_MS = 120000;
// After a summary could not be written, wait for this many new messages before
// asking for one again, so a failing summary is not requested at every step.
const SUMMARY_RETRY_AFTER_MESSAGES = 20;
const SUMMARY_REQUEST = `Write a handover note so this task can continue without the earlier messages. Use exact values, not descriptions.
1. What the user asked for.
2. What has been done so far: each site visited and what happened there.
3. Everything found that is still needed: names, URLs, lists, IDs, keys, numbers. Copy them exactly and leave nothing out of a list the task depends on.
4. What is left to do, in order.
5. What failed and why.`;

/** A signal that aborts when `signal` does or after `ms`, whichever comes first. */
function withDeadline(signal, ms) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, ms);
  signal?.addEventListener?.("abort", stop, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", stop);
    },
  };
}

// A provider can accept a request and then send nothing. Without a limit the
// task would wait for it forever, with "Thinking…" as its last word. After
// this long without a sign of life the call is given up as a passing failure:
// the next endpoint is tried, or the same one is asked again.
const MODEL_STALL_MS = 120000; // between two pieces of a streamed answer
const MODEL_REPLY_MS = 300000; // for an answer that comes in one piece
// With other endpoints to turn to (orchestrator mode), silence is waited out
// for half as long before the next one is asked.
const POOL_PATIENCE = 0.5;
// A lone endpoint that stays silent is asked this many times, then the task
// ends and says so.
const MAX_STALLED_TRIES = 2;

/**
 * Watches one model call. `signal` aborts when the task is stopped or when
 * nothing arrived for `ms`. `expired` rejects in the second case, so a call
 * that does not react to the abort cannot hold the task either. `touch()` is
 * the sign of life: it starts the wait again.
 */
function stallWatch(signal, ms) {
  const controller = new AbortController();
  let timer = null;
  let giveUp = () => {};
  const expired = new Promise((_resolve, reject) => {
    giveUp = reject;
  });
  const arm = (limit = ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`timed out: no answer for ${Math.round(limit / 1000)}s`);
      error.stalled = true;
      giveUp(error);
      controller.abort();
    }, limit);
  };
  const stop = () => controller.abort();
  signal?.addEventListener?.("abort", stop, { once: true });
  arm();
  return {
    signal: controller.signal,
    expired,
    touch: arm,
    clear: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", stop);
    },
  };
}

function normalizePool({ endpoints, providerConfig, model }) {
  if (Array.isArray(endpoints) && endpoints.length) {
    return endpoints
      .map((endpoint, index) => ({
        id: endpoint.id || `ep${index}`,
        providerId: endpoint.providerId,
        providerName: endpoint.providerName,
        model: endpoint.model || model || "",
        providerConfig: endpoint.providerConfig || providerConfig,
        label:
          endpoint.label ||
          `${endpoint.providerName || endpoint.providerConfig?.name || "provider"} / ${
            endpoint.model || model || "model"
          }`,
      }))
      .filter((endpoint) => endpoint.providerConfig && endpoint.model);
  }

  const name = providerConfig?.name || providerConfig?.type || "provider";
  return [
    {
      id: "single",
      providerId: providerConfig?.id,
      providerName: name,
      model,
      providerConfig,
      label: `${name} / ${model || "model"}`,
    },
  ];
}

const INTERRUPTED_TOOL_RESULT = "Interrupted before this tool finished.";

/**
 * Providers reject a history where an assistant tool call has no result
 * directly after it, or a tool result has no matching call. Stop, a worker
 * restart, or the stored-history cap can leave exactly that behind, so repair
 * the conversation in place before the next model call.
 *
 * @param {Array<object>} conversation
 * @returns {boolean} true when the conversation was changed
 */
export function repairToolPairs(conversation) {
  const repaired = [];
  let changed = false;
  let index = 0;

  while (index < conversation.length) {
    const message = conversation[index];
    index += 1;

    if (message?.role === "tool") {
      // A result with no assistant tool call directly before it.
      changed = true;
      continue;
    }
    repaired.push(message);

    const calls =
      message?.role === "assistant" && Array.isArray(message.toolCalls) ? message.toolCalls : [];
    if (!calls.length) continue;

    const pending = new Map(calls.map((call) => [call.id, call]));
    while (index < conversation.length && conversation[index]?.role === "tool") {
      const result = conversation[index];
      index += 1;
      if (pending.has(result.toolCallId)) {
        pending.delete(result.toolCallId);
        repaired.push(result);
      } else {
        changed = true;
      }
    }
    for (const call of pending.values()) {
      changed = true;
      repaired.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: INTERRUPTED_TOOL_RESULT,
        isError: true,
      });
    }
  }

  if (changed) conversation.splice(0, conversation.length, ...repaired);
  return changed;
}

/** Resolves after `ms`, or rejects as soon as the task is stopped. */
function pauseUnlessStopped(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped by user."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Stopped by user."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Runs one agentic turn: repeatedly calls the model, executes tool calls,
 * and feeds results back until the model answers without tools or the user
 * stops it. There is no step cap. A saved maxSteps value is ignored.
 *
 * When `endpoints` contains more than one entry, calls fail over in order:
 * a rate-limited, revoked, overloaded, or unreachable endpoint is cooled down
 * and the same model step is retried on the next endpoint. A failure that
 * usually passes (rate limit, overload, dropped connection) is waited out and
 * the step is asked again, so a long task is not ended by one bad minute.
 * `conversation` is mutated in place so the caller can persist it.
 *
 * `results` is what earlier turns of this chat saved with save_result. Each
 * change is handed to `onResults` as a new list, so the caller can store it.
 */
export async function runTurn({
  conversation,
  settings,
  providerConfig,
  model,
  endpoints,
  tabId,
  signal,
  emit,
  confirm,
  grantHost,
  saveSkill,
  addToGroup,
  onTargetTab,
  groupId,
  windowId,
  describeTabs = async () => null,
  persist = async () => {},
  wait = pauseUnlessStopped,
  summaryTimeoutMs = SUMMARY_TIMEOUT_MS,
  stallMs = MODEL_STALL_MS,
  replyMs = MODEL_REPLY_MS,
  results = [],
  onResults = async () => {},
}) {
  const basePrompt = buildSystemPrompt(settings);

  // What the task has collected so far. It rides along in the system prompt,
  // so it is still there after older messages are shortened or summarised.
  let saved = cleanResults(results);
  const keepResults = async (next) => {
    saved = next;
    try {
      await onResults(saved);
    } catch {
      // Storing is the caller's job; the list is still used for this turn.
    }
  };
  // Where the task is right now: without it the model does not know which
  // page the user is asking about. Asked before every model call, because the
  // task can move to another tab or page between two calls.
  const whereNow = async () => {
    try {
      return tabContextBlock(
        await describeTabs({ tabId: ctx.tabId, groupId, taskTabIds: ctx.taskTabIds })
      );
    } catch {
      // A tab that cannot be described (closed, restricted) does not stop the task.
      return "";
    }
  };
  const systemNow = async () =>
    [basePrompt, await whereNow(), resultsForModel(saved)].filter(Boolean).join("\n\n");
  const pool = normalizePool({ endpoints, providerConfig, model });
  if (!pool.length) throw new Error("No provider endpoint is configured.");

  const saveNow = async () => {
    try {
      await persist();
    } catch {}
  };

  const configuredAttempts = Number(settings?.orchestrator?.maxAttempts);
  const maxAttempts = Math.max(
    1,
    Math.min(200, Number.isFinite(configuredAttempts) ? configuredAttempts : 200)
  );
  const multi = pool.length > 1;
  const configuredRetries = Number(settings?.orchestrator?.transientRetries);
  const maxRetries = Number.isFinite(configuredRetries)
    ? Math.max(0, configuredRetries)
    : MAX_TRANSIENT_RETRIES;

  const saveResult = async (entry) => {
    await keepResults(addResult(saved, entry));
    return saved;
  };
  // taskTabIds: every tab this turn has been on or opened. With the tab group
  // they are the only tabs the tools may use.
  let ctx = { tabId, settings, emit, confirm, grantHost, saveSkill, saveResult, addToGroup, groupId, windowId, taskTabIds: [tabId] };
  let step = 0;
  const usedTools = [];
  let currentId = null;

  // One model call under watch: it ends with an answer, with the provider's
  // error, or because nothing came for too long.
  async function callEndpoint(endpoint, { streamId }) {
    const provider = createProvider(endpoint.providerConfig);
    const wantStream =
      settings.streaming !== false && typeof provider.chatStream === "function";
    const patience = (wantStream ? stallMs : replyMs) * (multi ? POOL_PATIENCE : 1);
    const watch = stallWatch(signal, patience);
    try {
      return await Promise.race([
        askEndpoint(endpoint, provider, { streamId, wantStream, watch }),
        watch.expired,
      ]);
    } finally {
      watch.clear();
    }
  }

  async function askEndpoint(endpoint, provider, { streamId, wantStream, watch }) {
    const callOpts = {
      messages: conversation,
      tools: TOOL_DEFS,
      system: await systemNow(),
      model: endpoint.model,
      signal: watch.signal,
      settings,
    };
    let streamed = "";

    if (!wantStream) {
      const res = await provider.chat(callOpts);
      return { res, streamed: false, endpoint };
    }

    // A reasoning model can think for a long time before it writes or acts.
    // Show the latest of it, a few times a second, so the wait is not silent.
    let thought = "";
    let thoughtShownAt = 0;

    try {
      const res = await provider.chatStream({
        ...callOpts,
        // Every piece that arrives, a tool call's included, is a sign of life.
        onActivity: () => watch.touch(),
        onDelta: (delta) => {
          if (!delta) return;
          streamed += delta;
          emit({ type: "assistant_delta", streamId, text: delta });
        },
        onThinking: (delta) => {
          if (!delta) return;
          thought += delta;
          const now = Date.now();
          if (now - thoughtShownAt < THINKING_UPDATE_MS) return;
          thoughtShownAt = now;
          emit({ type: "thinking", streamId, text: thinkingPreview(thought) });
        },
      });

      const hasCalls = Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
      // Some proxies ignore stream:true and answer with a plain JSON body.
      if (!streamed && !hasCalls && !String(res.text || "").trim()) {
        emit({
          type: "status",
          running: true,
          step,
          text: `Streaming returned no text from ${endpoint.label}; retrying…`,
        });
        watch.touch(replyMs);
        const fallback = await provider.chat(callOpts);
        return { res: fallback, streamed: false, endpoint };
      }
      return { res, streamed: true, endpoint };
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") throw error;

      // A definitive HTTP failure (auth, quota, overload, missing model) should
      // move to the next endpoint rather than retry the same one — except 400/
      // 404/422, where a provider may simply not support `stream:true`.
      if (
        isProviderError(error) &&
        ![400, 404, 422].includes(Number(error.status))
      ) {
        error.streamedText = streamed;
        throw error;
      }

      emit({
        type: "status",
        running: true,
        step,
        text: `Streaming unavailable from ${endpoint.label}; retrying without streaming…`,
      });
      try {
        watch.touch(replyMs);
        const fallback = await provider.chat(callOpts);
        if (streamed) emit({ type: "stream_reset", streamId });
        return { res: fallback, streamed: false, endpoint };
      } catch (fallbackError) {
        if (signal.aborted || fallbackError?.name === "AbortError") throw fallbackError;
        fallbackError.streamedText = streamed;
        throw fallbackError;
      }
    }
  }

  async function callWithFailover(streamId) {
    const order = (multi ? orderEndpoints(pool, currentId) : pool).slice(0, maxAttempts);

    if (!order.length) {
      const soonest = Math.min(...pool.map((endpoint) => cooldownRemaining(endpoint)));
      const seconds = Math.max(1, Math.ceil(soonest / 1000));
      const cooling = new Error(
        `All ${pool.length} orchestrator endpoint(s) are cooling down after errors. Retry in about ${seconds}s.`
      );
      cooling.retryAfterMs = transientCooldownRemaining(pool);
      cooling.transient = cooling.retryAfterMs > 0;
      cooling.reason = "every endpoint is cooling down";
      throw cooling;
    }

    let lastError = null;
    let lastEndpoint = null;
    let sawTransient = false;

    for (let index = 0; index < order.length; index++) {
      const endpoint = order[index];
      if (signal.aborted) throw new Error("Stopped by user.");

      if (multi) {
        emit({
          type: "orchestrator_attempt",
          endpoint: endpoint.label,
          index: index + 1,
          total: order.length,
          poolSize: pool.length,
        });
      }

      try {
        const out = await callEndpoint(endpoint, { streamId });
        markSuccess(endpoint);

        if (multi && currentId !== endpoint.id) {
          emit({
            type: "orchestrator_active",
            endpoint: {
              id: endpoint.id,
              label: endpoint.label,
              providerId: endpoint.providerId,
              model: endpoint.model,
            },
            endpoints: pool.length,
          });
        }
        currentId = endpoint.id;
        return out;
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") throw error;
        lastError = error;
        lastEndpoint = endpoint;
        if (isTransientFailure(error)) sawTransient = true;

        markFailure(endpoint, error, settings?.orchestrator?.cooldownSeconds);
        const next = order[index + 1];
        if (multi) {
          emit({
            type: "orchestrator_failover",
            from: endpoint.label,
            to: next?.label || null,
            reason: describeError(error),
            status: Number(error?.status) || 0,
            streamId,
            poolSize: pool.length,
            index: index + 1,
            attempted: order.length,
          });
        }
        if (error?.streamedText) emit({ type: "stream_reset", streamId });
      }
    }

    const failed = new Error(
      `All ${order.length} attempted endpoint(s) failed. Last: ${
        lastEndpoint?.label || "endpoint"
      }: ${describeError(lastError)}`
    );
    failed.transient = sawTransient;
    failed.stalled = !!lastError?.stalled;
    failed.retryAfterMs = multi
      ? transientCooldownRemaining(pool)
      : Number(lastError?.retryAfterMs) || 0;
    failed.reason = describeError(lastError);
    throw failed;
  }

  // A long task should outlive a rate limit, an overloaded provider or a
  // dropped connection: wait, then ask for the same step again.
  async function callWithRetry(streamId) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callWithFailover(streamId);
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") throw error;
        // Silence is waited out only so often: each try costs minutes.
        const silentTooOften = error?.stalled && attempt >= MAX_STALLED_TRIES;
        const waitMs = error?.transient && !silentTooOften
          ? transientRetryDelay({ attempt, retryAfterMs: error.retryAfterMs, maxRetries })
          : null;
        if (waitMs == null) throw error;
        emit({
          type: "status",
          running: true,
          step,
          text: `Provider problem (${error.reason}). Trying again in ${Math.ceil(waitMs / 1000)}s…`,
        });
        await wait(waitMs, signal);
      }
    }
  }

  const budget = contextBudget(pool);
  let summaryFailedAt = -SUMMARY_RETRY_AFTER_MESSAGES;

  // Asks each endpoint in turn for a handover note, within one shared time
  // limit. Returns "" when none could write one.
  async function writeSummary() {
    const deadline = Date.now() + summaryTimeoutMs;
    for (const endpoint of pool) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const limit = withDeadline(signal, left);
      try {
        const res = await createProvider(endpoint.providerConfig).chat({
          messages: [{ role: "user", content: `${SUMMARY_REQUEST}\n\n${messagesForSummary(conversation)}` }],
          tools: [],
          system: "You write precise handover notes.",
          model: endpoint.model,
          signal: limit.signal,
          settings,
        });
        const summary = (res.text || "").trim();
        if (summary) return summary;
      } catch (error) {
        // Stopped by the user: end the task. Anything else, including the
        // time limit: try the next endpoint or go on without a summary.
        if (signal.aborted) throw error;
      } finally {
        limit.clear();
      }
    }
    return "";
  }

  // A long task reads many pages. Older page reads are cut to their beginning
  // first: that needs no model call and every step stays in place. A summary
  // replaces the older steps only when that is still not enough.
  async function keepWithinBudget() {
    if (conversationSize(conversation) < budget) return;
    const trimmed = trimOldToolResults(conversation, { keepFullChars: budget * FULL_RESULTS_SHARE });
    if (trimmed.changed) {
      conversation.splice(0, conversation.length, ...trimmed.messages);
      await saveNow();
    }
    if (!shouldCompact(conversation, { minChars: budget })) return;
    if (conversation.length - summaryFailedAt < SUMMARY_RETRY_AFTER_MESSAGES) return;

    emit({
      type: "status",
      running: true,
      step,
      text: "Compacting our conversation so we can keep chatting…",
    });
    const summary = await writeSummary();
    if (!summary) {
      summaryFailedAt = conversation.length;
      return;
    }
    summaryFailedAt = -SUMMARY_RETRY_AFTER_MESSAGES;
    const compacted = applyCompaction(conversation, summary);
    conversation.splice(0, conversation.length, ...compacted);
    await saveNow();
    emit({ type: "compacted", text: "Conversation compacted" });
  }

  if (repairToolPairs(conversation)) await saveNow();

  while (true) {
    if (signal.aborted) throw new Error("Stopped by user.");

    await keepWithinBudget();

    step += 1;
    emit({
      type: "status",
      running: true,
      step,
      text: "Thinking…",
    });

    const streamId = `s${step}`;
    const out = await callWithRetry(streamId);
    const res = out.res;
    // Reasoning models (e.g. Kimi K3.1) can spend the whole token budget in
    // reasoning_content and return no content. Use it rather than "(empty)".
    if (!String(res.text || "").trim() && !(res.toolCalls || []).length && res.reasoning) {
      res.text = res.reasoning;
    }
    const hasToolCalls = Array.isArray(res.toolCalls) && res.toolCalls.length > 0;

    if (!hasToolCalls) {
      const answer = (res.text || "").trim() || "(The model returned an empty response.)";
      // The model may end without listing what it collected. Results the user
      // has not been shown yet are added under the answer, all together.
      const unshown = hasUnshownResults(saved);
      const text = unshown ? answerWithResults(answer, saved) : answer;
      if (unshown) await keepResults(markResultsShown(saved));
      conversation.push({
        role: "assistant",
        content: text,
        ...(res.reasoning ? { reasoning: res.reasoning } : {}),
      });
      await saveNow();
      if (usedTools.length) {
        emit({
          type: "skill_offer",
          title: String(conversation.find((message) => message.role === "user")?.content || "Learned task").slice(0, 80),
          tools: usedTools.slice(0, 12),
          instructions: usedTools.map((name, index) => `${index + 1}. ${name}`).join("\n"),
        });
      }
      emit({
        type: "assistant_final",
        text,
        // Read aloud, when that is on: the model's words, not the saved values.
        spoken: answer,
        step,
        streamId,
        streamed: out.streamed,
        endpoint: out.endpoint?.label || null,
      });
      return { tabId: ctx.tabId, endpoint: out.endpoint };
    }

    conversation.push({
      role: "assistant",
      content: res.text || "",
      toolCalls: res.toolCalls,
      ...(res.reasoning ? { reasoning: res.reasoning } : {}),
    });
    await saveNow();

    // Screenshots go to the model as user messages. They must come after every
    // tool result of this step, or the results no longer follow their calls.
    const screenshotMessages = [];

    for (const tc of res.toolCalls) {
      if (signal.aborted) throw new Error("Stopped by user.");

      emit({
        type: "step",
        phase: "running",
        id: tc.id,
        name: tc.name,
        args: tc.args,
      });

      let toolOut;
      let isError = false;
      try {
        toolOut = await executeTool(tc.name, tc.args, ctx);
        if (toolOut && Number.isInteger(toolOut.tabId)) {
          ctx.tabId = toolOut.tabId;
          ctx.taskTabIds = [...new Set([...ctx.taskTabIds, toolOut.tabId])];
          if (typeof onTargetTab === "function") onTargetTab(toolOut.tabId);
        }
      } catch (e) {
        toolOut = { text: `Error: ${e?.message || e}` };
        isError = true;
      }

      conversation.push({
        role: "tool",
        toolCallId: tc.id,
        name: tc.name,
        content: toolOut.text || "",
        isError,
      });
      await saveNow();

      if (!isError) usedTools.push(tc.name);
      emit({
        type: "step",
        phase: isError ? "error" : "done",
        id: tc.id,
        name: tc.name,
        args: tc.args,
        result: (toolOut.text || "").slice(0, 1200),
        image: toolOut.image || null,
      });

      if (toolOut.image && settings.sendScreenshots) {
        screenshotMessages.push({
          role: "user",
          content: "Screenshot of the current page:",
          image: toolOut.image,
          auto: true,
        });
      }
    }

    conversation.push(...screenshotMessages);
  }

}
