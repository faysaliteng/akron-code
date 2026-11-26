// Runs the brand check (shared/brand.js) against this installed copy's own
// files. The answer cannot change while the worker lives, so it is worked out
// once and reused.

import { BRAND_BLOCKED_MESSAGE, checkBrand } from "../shared/brand.js";

let pending = null;

async function ownFile(file) {
  const response = await fetch(chrome.runtime.getURL(file));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** @returns {Promise<string[]>} what was changed in this copy; empty when intact */
export async function brandProblems() {
  pending ||= checkBrand({
    readText: async (file) => (await ownFile(file)).text(),
    readBytes: async (file) => (await ownFile(file)).arrayBuffer(),
  });
  const problems = await pending;
  // A failed check is not kept: a file that could not be read just then gets
  // another try with the next task.
  if (problems.length) pending = null;
  return problems;
}

export async function assertBrandIntact() {
  const problems = await brandProblems();
  if (problems.length) throw new Error(BRAND_BLOCKED_MESSAGE);
}
