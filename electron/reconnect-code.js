/**
 * Turning whatever the user pastes into the Claude reconnect box into the one
 * string the Claude Code CLI's login exchange accepts.
 *
 * Ground truth, observed from `claude auth login` on this machine:
 *   - `abc123`         -> "That doesn't look like the full code. Copy all of
 *                         it, including the # in the middle." and the CLI keeps
 *                         waiting (it never exits, so no result event fires)
 *   - `abc123#def456`  -> a real exchange, then its own verdict
 *
 * So a bare code is rejected here, where the paste box can stay open, instead
 * of being forwarded so the CLI can stall forever. A pasted callback URL (what
 * the address bar holds when the browser could not reach `localhost`) carries
 * both halves and is normalised rather than refused.
 */

const URL_LIKE = /^https?:\/\//i;

/** @returns {{ok:true, value:string}|{ok:false, error:string}} */
function normalizeReconnectCode(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'paste the code the sign-in page shows' };

  if (URL_LIKE.test(raw)) {
    let u = null;
    try { u = new URL(raw); } catch (_) { u = null; }
    const code = (u && u.searchParams.get('code')) || '';
    const state = (u && u.searchParams.get('state')) || '';
    // A URL without a code never came from the callback; let the CLI judge it.
    if (!code) return { ok: true, value: raw };
    return { ok: true, value: state ? code + '#' + state : code };
  }

  // `code#state` is exactly what the manual callback page prints.
  if (raw.indexOf('#') === -1) {
    return { ok: false, error: 'the page shows code#state — copy all of it, including the # in the middle' };
  }
  return { ok: true, value: raw };
}

/**
 * Language the CLI uses when it is still waiting for a usable paste. Those
 * lines must re-enable the box; anything else means it ran an exchange.
 */
function isRetryableLine(line) {
  return /full code|# in the middle|copy all of it/i.test(String(line || ''));
}

module.exports = { normalizeReconnectCode, isRetryableLine };
