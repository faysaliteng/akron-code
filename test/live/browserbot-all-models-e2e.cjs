'use strict';
const { app, dialog } = require('electron');
dialog.showErrorBox = () => {};

const assert = require('assert');
const extbridge = require('../../electron/extbridge');
const store = require('../../electron/store');
const providerOauth = require('../../electron/provider-oauth');
const freellm = require('../../electron/freellm');
const providertransport = require('../../electron/providertransport');
const modelCatalog = require('../../electron/model-catalog');

async function hydrateProvider(p) {
  if (!p || !p.oauthProvider) return p;
  const r = await providerOauth.resolve(String(p.oauthProvider));
  const out = Object.assign({}, p, {
    transport: r.transport,
    accessToken: r.accessToken,
    account: r.account,
    accountId: r.accountId || p.accountId || '',
    codexUrl: r.codexUrl || p.codexUrl || '',
    cloudcodeUrl: r.cloudcodeUrl || p.cloudcodeUrl || '',
    oauth: true,
    model: p.model || (r.models && r.models[0] && r.models[0].id) || '',
  });
  if (!providertransport.needsTransport({ transport: r.transport })) {
    out.transport = '';
    out.apiKey = r.accessToken;
    out.baseURL = r.baseURL || p.baseURL || '';
    out.supportsTools = true;
  }
  return out;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_text',
      description: 'Read visible plain text on the current browser tab.',
      parameters: { type: 'object', properties: { maxChars: { type: 'number' } } },
    },
  },
];

async function testModelTwoTurn(baseUrl, model) {
  const t0 = Date.now();
  const sys = 'You are Akron Browser Bot. Always call read_text first before answering questions about page numbers. Be concise.';
  const msgs1 = [
    { role: 'system', content: sys },
    { role: 'user', content: 'Check today and yesterday orders on this page.' },
  ];

  const post = async (messages, includeTools = true) => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer akron-desktop-local' },
      body: JSON.stringify({
        model,
        messages,
        ...(includeTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
        max_tokens: 400,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 300);
      const err = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  };

  const r1 = await post(msgs1, true);
  const m1 = r1.choices && r1.choices[0] && r1.choices[0].message;
  assert.ok(m1, `${model}: Turn 1 missing choice.message`);

  const conv = [...msgs1];
  let turn1ToolCalled = false;
  if (Array.isArray(m1.tool_calls) && m1.tool_calls.length > 0) {
    turn1ToolCalled = true;
    conv.push({ role: 'assistant', content: m1.content || '', tool_calls: m1.tool_calls });
    for (const tc of m1.tool_calls) {
      conv.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: 'Profit overview: Today 16 orders $27.00 | Yesterday 50 orders $156.36 | This month (2026-11) 1347 orders $3,588.24 | Previous month (2026-10) 1120 orders $2,980.00 | Last order #30090.',
      });
    }
    const r1b = await post(conv, true);
    const m1b = r1b.choices && r1b.choices[0] && r1b.choices[0].message;
    assert.ok(m1b && m1b.content, `${model}: Turn 1 post-tool answer empty`);
    conv.push({ role: 'assistant', content: m1b.content });
  } else {
    const synId = 'call_syn_' + Date.now().toString(36);
    conv.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: synId, type: 'function', function: { name: 'read_text', arguments: '{"maxChars":2000}' } }],
    });
    conv.push({
      role: 'tool',
      tool_call_id: synId,
      content: 'Profit overview: Today 16 orders $27.00 | Yesterday 50 orders $156.36 | This month (2026-11) 1347 orders $3,588.24 | Previous month (2026-10) 1120 orders $2,980.00 | Last order #30090.',
    });
    conv.push({ role: 'assistant', content: m1.content || 'Today has 16 orders ($27.00) and yesterday had 50 orders ($156.36).' });
  }

  conv.push({
    role: 'user',
    content: 'check whole month and compare to previous month based on the data above, reply in one sentence.',
  });
  const r2 = await post(conv, true);
  const m2 = r2.choices && r2.choices[0] && r2.choices[0].message;
  const answer = (m2 && (m2.content || (m2.tool_calls && m2.tool_calls.length ? '[tool_call]' : ''))) || '';
  assert.ok(answer.length > 0, `${model}: Turn 2 returned empty`);
  return {
    ok: true,
    model,
    servedBy: r2.model,
    turn1ToolCalled,
    ms: Date.now() - t0,
    reply: answer.replace(/\s+/g, ' ').slice(0, 120),
  };
}

app.whenReady().then(async () => {
  try {
    const started = await extbridge.start({
      port: 0,
      getProvider: async () => {
        const s = store.getSettings() || {};
        let p = s.provider || {};
        if (p.oauthProvider) { try { p = await hydrateProvider(p); } catch (_) {} }
        if (!p.apiKey && /:3001\b/.test(String(p.baseURL || ''))) {
          const c = freellm.loadConfig ? freellm.loadConfig() : null;
          if (c && c.token) p = { ...p, apiKey: c.token };
        }
        return p;
      },
      getOrchestrator: async () => {
        const orch = store.getOrchestrator() || {};
        const rows = Array.isArray(orch.providers) ? await Promise.all(orch.providers.map(async (r) => {
          if (r && r.oauthProvider) { try { return await hydrateProvider(r); } catch (_) { return r; } }
          return r;
        })) : [];
        return { ...orch, providers: rows };
      },
      getExtraProviders: async () => {
        const extras = [];
        const accts = providerOauth.listAccounts ? providerOauth.listAccounts() : [];
        const liveSnap = modelCatalog.snapshot ? modelCatalog.snapshot() : {};
        for (const a of accts) {
          if (!a || a.needsSignIn) continue;
          try {
            const hydrated = await hydrateProvider({ oauthProvider: a.id, id: a.provider, name: a.label });
            const pv = providerOauth.provider ? providerOauth.provider(a.provider) : null;
            const liveList = Array.isArray(liveSnap[a.provider]) ? liveSnap[a.provider].map((m) => m.id) : [];
            const staticList = pv && Array.isArray(pv.models) ? pv.models.map((m) => m.id) : [];
            const catalogModels = [...new Set([...liveList, ...staticList].filter(Boolean))];
            if (!hydrated.model && catalogModels.length) hydrated.model = catalogModels[0];
            hydrated.catalogModels = catalogModels;
            extras.push(hydrated);
          } catch (e) {
            console.log(`OAUTH_HYDRATE_SKIP ${a.id}: ${e.message}`);
          }
        }
        const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
        if (cfg && cfg.token) {
          const aliasKeys = freellm.ALIASES ? Object.keys(freellm.ALIASES) : [];
          const liveModels = freellm.listModels ? await Promise.resolve(freellm.listModels(cfg)).catch(() => []) : [];
          const cleanLive = liveModels
            .map((m) => (typeof m === 'string' ? m : m && m.id))
            .map((id) => String(id || '').trim())
            .filter((id) => id && !id.startsWith('[') && !/\s/.test(id) && /^(qwen|deepseek|nemotron|mistral|devstral|gpt-oss|kimi|glm|llama)/i.test(id))
            .slice(0, 40);
          const catalogModels = [...new Set([...aliasKeys, ...cleanLive].filter(Boolean))];
          extras.push({
            id: 'freellmapi',
            name: 'FreeLLMAPI Pool',
            baseURL: 'http://127.0.0.1:3001/v1',
            apiKey: cfg.token,
            model: catalogModels[0] || 'qwen3.8-flash',
            catalogModels,
            supportsTools: true,
          });
        }
        return extras;
      },
    });
    assert.ok(started && started.ok, 'extbridge failed to start');
    const baseUrl = `http://127.0.0.1:${started.port}`;

    const modelsRes = await fetch(`${baseUrl}/v1/models`).then((r) => r.json());
    const ids = (modelsRes.data || []).map((m) => m.id);
    console.log(`MODELS_COUNT=${ids.length} LIST=${ids.slice(0, 20).join(', ')}`);

    const coreTargets = [
      'claude-opus-5-5-medium',
      'claude-sonnet-5-5-medium',
      'gemini-4-neon-high',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'qwen3.8-flash',
      'gpt-oss-120b',
      'gemma4:latest',
      'akron-default',
    ];
    const probeTargets = ['grok-4-fast', 'gpt-5.6-terra'];

    const results = [];
    for (const m of [...coreTargets, ...probeTargets]) {
      try {
        const r = await testModelTwoTurn(baseUrl, m);
        results.push(r);
        console.log(`PASS ${m} (servedBy=${r.servedBy}, t1Tool=${r.turn1ToolCalled}, ${r.ms}ms): ${r.reply}`);
      } catch (e) {
        const isProbe = probeTargets.includes(m);
        console.log(`${isProbe ? 'PROBE_STATUS' : 'FAIL'} ${m}: ${e.message}`);
        results.push({ ok: false, model: m, isProbe, error: e.message });
      }
    }

    await extbridge.stop();
    const coreFailures = results.filter((r) => !r.ok && !r.isProbe);
    const nonKeychainFailures = coreFailures.filter((r) => !/needs to be signed in again|no stored tokens/i.test(String(r.error || '')));
    if (nonKeychainFailures.length > 0) {
      console.error('CORE_MODEL_FAILURES:', JSON.stringify(nonKeychainFailures, null, 2));
      app.exit(1);
    } else {
      console.log('BROWSERBOT_ALL_ACCESSIBLE_MODELS_E2E_OK (non-CLI OAuth keychain items require the signed app bundle)');
      app.exit(0);
    }
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
