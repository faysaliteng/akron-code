// The tab group's title says how its task stands, the way Claude's does: an
// hourglass while it works, a bell when it waits for the user, a tick when it
// finished out of sight. Pure functions; the worker applies the result.

export const GROUP_MARKS = Object.freeze({
  working: "⌛",
  needs_user: "🔔",
  done: "✅",
});

const DEFAULT_NAME = "Akron";
const LEADING_MARK = new RegExp(`^(?:${Object.values(GROUP_MARKS).join("|")})\\s*`);

/** The group's name without a status mark in front. */
export function plainGroupTitle(title) {
  return String(title ?? "").replace(LEADING_MARK, "").trim();
}

/**
 * The title to show for a group.
 * @param {string} name the group's own name
 * @param {"working"|"needs_user"|"done"|null} [status]
 */
export function markedGroupTitle(name, status) {
  const plain = plainGroupTitle(name) || DEFAULT_NAME;
  const mark = Object.hasOwn(GROUP_MARKS, status) ? GROUP_MARKS[status] : "";
  return mark ? `${mark} ${plain}` : plain;
}
