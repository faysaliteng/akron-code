// What a task has collected for the user: API keys, links, codes, prices, and
// the ones that could not be collected. Kept apart from the conversation, so
// nothing here is lost when older messages are shortened, summarised or dropped
// from storage. Pure functions: every change returns a new list.

export const MAX_RESULTS = 100;
const LABEL_CHARS = 120;
const VALUE_CHARS = 2000;
const NOTE_CHARS = 300;
// How much of one value the model is reminded of on each step.
const MODEL_VALUE_CHARS = 500;

function oneLine(text, max) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A clean copy of one saved result, or null when it has no label or says nothing. */
function cleanResult(entry) {
  if (!entry || typeof entry !== "object") return null;
  const label = oneLine(entry.label, LABEL_CHARS);
  const value = String(entry.value ?? "").trim().slice(0, VALUE_CHARS);
  const note = oneLine(entry.note, NOTE_CHARS);
  if (!label || (!value && !note)) return null;
  return { label, value, note, shown: entry.shown === true };
}

/** A clean copy of a stored list. Anything that is not a result is left out. */
export function cleanResults(list) {
  return (Array.isArray(list) ? list : []).map(cleanResult).filter(Boolean).slice(0, MAX_RESULTS);
}

/**
 * A new list with `entry` saved. A value never overwrites another value: the
 * same label again only replaces an entry that had no value yet.
 * @param {object[]} list
 * @param {{ label?: string, value?: string, note?: string }} entry
 * @returns {object[]}
 */
export function addResult(list, entry) {
  const current = cleanResults(list);
  const label = oneLine(entry?.label, LABEL_CHARS);
  if (!label) throw new Error("Give the result a label that says what it is and where it is from.");
  const clean = cleanResult({ label, value: entry?.value, note: entry?.note });
  if (!clean) throw new Error("Give a value, or a note saying why it could not be collected.");

  const key = label.toLowerCase();
  const sameLabel = current.filter((item) => item.label.toLowerCase() === key);
  if (clean.value && sameLabel.some((item) => item.value === clean.value)) return current;
  const waiting = current.findIndex((item) => item.label.toLowerCase() === key && !item.value);
  if (waiting >= 0) return current.map((item, index) => (index === waiting ? clean : item));
  // Nothing new to say about something already collected.
  if (!clean.value && sameLabel.length) return current;
  if (current.length >= MAX_RESULTS) {
    throw new Error(`There is room for ${MAX_RESULTS} saved results and all are used.`);
  }
  return [...current, clean];
}

export function hasUnshownResults(list) {
  return cleanResults(list).some((item) => !item.shown);
}

export function markResultsShown(list) {
  return cleanResults(list).map((item) => ({ ...item, shown: true }));
}

/** What the model is reminded of on every step, or "" when nothing is saved. */
export function resultsForModel(list) {
  const items = cleanResults(list);
  if (!items.length) return "";
  const lines = items.map((item, index) => {
    const value = item.value ? oneLine(item.value, MODEL_VALUE_CHARS) : "(not collected)";
    return `${index + 1}. ${item.label}: ${value}${item.note ? ` (${item.note})` : ""}`;
  });
  return `Results saved so far with save_result (${items.length}). They are kept for the whole task and the user is shown all of them at the end:\n${lines.join("\n")}`;
}

function shownValue(value) {
  const flat = oneLine(value, VALUE_CHARS);
  return flat.includes("`") ? flat : `\`${flat}\``;
}

/** Everything saved, together, as the user reads it. "" when nothing is saved. */
export function resultsReport(list, { heading = "Saved results" } = {}) {
  const items = cleanResults(list);
  if (!items.length) return "";
  const collected = items.filter((item) => item.value).length;
  const lines = items.map((item) => {
    const value = item.value ? shownValue(item.value) : "not collected";
    return `- **${item.label}:** ${value}${item.note ? ` (${item.note})` : ""}`;
  });
  return `**${heading} (${collected} of ${items.length} collected)**\n\n${lines.join("\n")}`;
}

const REPORT_START = /\*\*[^*\n]+ \(\d+ of \d+ collected\)\*\*\n\n- /;
// Shorter than this, a value is too likely to be an ordinary word.
const MASKED_VALUE_MIN_CHARS = 6;

/**
 * A line that is safe to show outside the chat (the history list, a desktop
 * notification): no results list, and no collected value anywhere in it.
 */
export function previewWithoutResults(text, list) {
  const raw = String(text || "");
  const listAt = raw.search(REPORT_START);
  const head = listAt < 0 ? raw : raw.slice(0, listAt).trim() || "The saved results are in the chat.";
  return cleanResults(list)
    .map((item) => item.value)
    .filter((value) => value.length >= MASKED_VALUE_MIN_CHARS)
    .reduce((line, value) => line.split(value).join("…"), head);
}

function answerGivesEverything(items, answer) {
  const lower = answer.toLowerCase();
  return items.every((item) =>
    item.value ? answer.includes(item.value) : lower.includes(item.label.toLowerCase())
  );
}

/** The answer, with every saved result added under it unless it already gives them all. */
export function answerWithResults(answer, list) {
  const text = String(answer || "").trim();
  const items = cleanResults(list);
  if (!items.length || answerGivesEverything(items, text)) return text;
  return `${text}\n\n${resultsReport(items)}`.trim();
}
