// Applies the optional local-provider.json seed to what the extension has
// stored. Pure: it returns new lists and never changes its arguments.
//
// Seed file shape:
//   {
//     "version": 2,
//     "providers": [{ id, name, type, baseUrl, apiKey, models, defaultModel, ... }],
//                                            // "replace": true makes the file's key,
//                                            // address and models overwrite stored ones
//     "orchestrator": {                      // optional
//       "enabled": true,
//       "endpoints": [{ "providerId": "...", "model": "..." }]
//     }
//   }

function seedProviders(seed) {
  const list = Array.isArray(seed?.providers) ? seed.providers : [];
  return list.filter((provider) => provider && typeof provider === "object" && provider.id && provider.baseUrl);
}

function sameEndpoint(a, b) {
  return a?.providerId === b?.providerId && a?.model === b?.model;
}

// The seed's models go to the front of the orchestrator pool, in the seed's
// order, because the pool is tried from the top. Models the user had selected
// stay, after them.
function withSeededPool(settings, seedOrchestrator, providers) {
  const wanted = Array.isArray(seedOrchestrator?.endpoints) ? seedOrchestrator.endpoints : [];
  const seeded = [];
  for (const entry of wanted) {
    const endpoint = { providerId: String(entry?.providerId || ""), model: String(entry?.model || "").trim(), enabled: true };
    if (!endpoint.providerId || !endpoint.model) continue;
    if (!providers.some((provider) => provider.id === endpoint.providerId)) continue;
    if (seeded.some((existing) => sameEndpoint(existing, endpoint))) continue;
    seeded.push(endpoint);
  }
  if (!seeded.length) return settings;
  const current = settings.orchestrator || {};
  const kept = (Array.isArray(current.endpoints) ? current.endpoints : []).filter(
    (existing) => !seeded.some((endpoint) => sameEndpoint(endpoint, existing))
  );
  return {
    ...settings,
    orchestrator: {
      ...current,
      enabled: seedOrchestrator.enabled === true ? true : !!current.enabled,
      endpoints: [...seeded, ...kept],
    },
  };
}

/**
 * @param {{ seed: object, providers: object[], settings: object }} input
 * @returns {{ providers: object[], settings: object, providersChanged: boolean }}
 *   New provider list and settings. A provider that is already stored keeps
 *   everything the user set; only a missing API key is filled in.
 */
export function applyLocalSeed({ seed, providers, settings }) {
  let nextProviders = Array.isArray(providers) ? [...providers] : [];
  let nextSettings = { ...(settings || {}) };
  let providersChanged = false;

  for (const incoming of seedProviders(seed)) {
    const index = nextProviders.findIndex((provider) => provider.id === incoming.id);
    if (index === -1) {
      const { replace: _replace, ...added } = incoming;
      nextProviders = [...nextProviders, added];
      providersChanged = true;
    } else if (incoming.replace === true) {
      // "replace": the file's key, address and models win over what is stored,
      // e.g. after the proxy's key was renewed. The user's other settings stay.
      const { replace: _replace, ...fromFile } = incoming;
      const pick = ["name", "apiKey", "apiKeys", "baseUrl", "models", "defaultModel"];
      const update = Object.fromEntries(pick.filter((key) => key in fromFile).map((key) => [key, fromFile[key]]));
      const current = nextProviders[index];
      if (pick.some((key) => key in update && JSON.stringify(current[key]) !== JSON.stringify(update[key]))) {
        nextProviders = nextProviders.map((provider, i) => (i === index ? { ...provider, ...update } : provider));
        providersChanged = true;
      }
    } else if (!nextProviders[index].apiKey && incoming.apiKey) {
      nextProviders = nextProviders.map((provider, i) =>
        i === index ? { ...provider, apiKey: incoming.apiKey } : provider
      );
      providersChanged = true;
    }
    if (!nextSettings.activeProviderId) {
      nextSettings = {
        ...nextSettings,
        activeProviderId: incoming.id,
        activeModel: incoming.defaultModel || incoming.models?.[0] || null,
      };
    }
  }

  nextSettings = withSeededPool(nextSettings, seed?.orchestrator, nextProviders);
  return { providers: nextProviders, settings: nextSettings, providersChanged };
}
