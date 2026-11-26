// Saved-provider hydration for the composer/settings endpoint config.
// Kept out of App.jsx (JSX) so the merge rule is unit-testable in plain node.

import { normBase } from './providerstatus-ui.mjs';

// Loopback spellings are the same endpoint. A router saved as 127.0.0.1 must
// find the preset written as localhost, otherwise a wiped model leaves the
// picker empty for no reason.
export const endpointKey = (u) => normBase(u).replace(
  /:\/\/(127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i,
  '://localhost'
);

/**
 * Merge a persisted provider config over the built-in default.
 *
 * A model id and an API key belong to the endpoint they were chosen for, so a
 * saved config pointing at a different base URL must not inherit either from
 * the default. Without this rule a wiped model produced
 * `baseURL=http://127.0.0.1:3001/v1` + `model=nvidia/nemotron-3.5-bolt-e4b`
 * (an id the local router does not serve), and a saved custom endpoint with no
 * key inherited NVIDIA's real key. Missing fields are filled from the preset
 * that matches the saved base URL — never from a different host's default.
 */
export function hydrateProvider(stored, defaults, presets) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  const base = { ...defaults, ...s };
  const wanted = endpointKey(s.baseURL || defaults.baseURL);
  if (wanted !== endpointKey(defaults.baseURL)) {
    const preset = (presets || []).find((p) => p && p.baseURL && endpointKey(p.baseURL) === wanted);
    if (!s.model) base.model = preset ? preset.model : '';
    if (!s.apiKey) base.apiKey = preset ? preset.apiKey : '';
  }
  return base;
}

export default hydrateProvider;
