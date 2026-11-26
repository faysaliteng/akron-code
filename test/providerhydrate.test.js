'use strict';
// The composer hydrates its saved endpoint over the built-in default. A model
// id and an API key belong to the endpoint they were chosen on, so the merge
// must never move NVIDIA's model/key onto a different base URL. This was a live
// bug: a wiped model produced `127.0.0.1:3001/v1` + `nvidia/nemotron-…` (an id
// the local router does not serve), and a keyless custom endpoint inherited
// NVIDIA's real key.

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; process.exitCode = 1; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const DEFAULTS = {
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: 'nvapi-SECRET',
  model: 'nvidia/nemotron-3.5-bolt-e4b',
  temperature: 0.7, maxTokens: 8192, reasoningLevel: 'auto', supportsTools: true,
};
const PRESETS = [
  { name: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: 'nvapi-SECRET' },
  { name: 'FreeLLMAPI (local router)', baseURL: 'http://localhost:3001/v1', model: 'auto', apiKey: '' },
  { name: 'Groq (free tier)', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '' },
  { name: 'Custom', baseURL: '', model: '', apiKey: '' },
];

(async () => {
  const { hydrateProvider } = await import('../src/providerhydrate.mjs');

  console.log('\nprovider hydration');
  eq('nothing saved yields the default untouched', hydrateProvider({}, DEFAULTS, PRESETS), DEFAULTS);

  // The live failure: local router saved, model wiped by a reset.
  {
    const got = hydrateProvider({ baseURL: 'http://127.0.0.1:3001/v1', apiKey: '' }, DEFAULTS, PRESETS);
    ok('a local router never inherits the NVIDIA model', !/nemotron/.test(got.model), got.model);
    eq('127.0.0.1 finds the localhost preset', got.model, 'auto');
    eq('and keeps the saved base URL', got.baseURL, 'http://127.0.0.1:3001/v1');
    eq('and inherits no NVIDIA key', got.apiKey, '');
    eq('while non-endpoint prefs still come from defaults', got.temperature, 0.7);
  }

  // Same host spelled differently (localhost vs 127.0.0.1) is a preset match.
  {
    const got = hydrateProvider({ baseURL: 'http://localhost:3001/v1/' }, DEFAULTS, PRESETS);
    eq('a matching preset supplies its own model', got.model, 'auto');
  }

  {
    const got = hydrateProvider({ baseURL: 'http://[::1]:3001/v1' }, DEFAULTS, PRESETS);
    eq('the IPv6 loopback spelling matches too', got.model, 'auto');
  }

  {
    const got = hydrateProvider({ baseURL: 'https://api.groq.com/openai/v1' }, DEFAULTS, PRESETS);
    eq('a known non-default preset gets its own model', got.model, 'llama-3.3-70b-versatile');
    eq('and no NVIDIA key', got.apiKey, '');
  }

  // A custom box has no preset: keep the model empty rather than borrowing.
  {
    const got = hydrateProvider({ baseURL: 'https://box.example.com/v1' }, DEFAULTS, PRESETS);
    eq('an unknown endpoint gets no borrowed model', got.model, '');
    eq('and no borrowed key', got.apiKey, '');
  }

  // A saved model/key on a foreign endpoint is the user's own choice: keep it.
  {
    const got = hydrateProvider({ baseURL: 'https://box.example.com/v1', model: 'my/model', apiKey: 'sk-mine' }, DEFAULTS, PRESETS);
    eq('a saved model on a foreign endpoint survives', got.model, 'my/model');
    eq('a saved key on a foreign endpoint survives', got.apiKey, 'sk-mine');
  }

  // Saving the default endpoint keeps the default model even with model ''.
  {
    const got = hydrateProvider({ baseURL: 'https://integrate.api.nvidia.com/v1' }, DEFAULTS, PRESETS);
    eq('the default endpoint is untouched', got.model, 'nvidia/nemotron-3.5-bolt-e4b');
    eq('and keeps the shipped key', got.apiKey, 'nvapi-SECRET');
  }

  eq('null is treated as nothing saved', hydrateProvider(null, DEFAULTS, PRESETS), DEFAULTS);
  ok('the default object is never mutated', DEFAULTS.model === 'nvidia/nemotron-3.5-bolt-e4b');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
