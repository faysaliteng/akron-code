// A/B proof that the Gemini function-declaration lowering is what fixes the
// Antigravity 400: send the *same* tool twice, once with its raw JSON Schema
// (the pre-fix wire shape) and once lowered, and print the endpoint's verdict.
'use strict';
const path = require('path');
if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const r = spawnSync(bin, [__filename], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 2 : r.status);
}
const { app } = require('electron');
// safeStorage is keyed on the app's own name; adopt the real one so the stored
// grant decrypts exactly as it does inside Akron Bot.
app.setName(require('../package.json').productName || 'Akron Bot');
const oauth = require('../electron/provider-oauth');
const t = require('../electron/providertransport');
const { toolDefinitions } = require('../electron/tools');

const raw = toolDefinitions.find((x) => x.name === 'mcp__cowork__orchestrate');
if (!raw) { console.error('tool not found'); process.exit(2); }

const send = async (provider, parameters, label) => {
  const body = {
    model: provider.model,
    request: {
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
      generationConfig: { maxOutputTokens: 32 },
      tools: [{ functionDeclarations: [{ name: 'mcp__cowork__orchestrate', description: 'test', parameters }] }],
    },
    userAgent: 'antigravity',
    requestType: 'agent',
  };
  const base = (provider && provider.baseURL) || t._internal.DEFAULT_GEMINI_BASE;
  const res = await fetch(`${base.replace(/\/+$/, '')}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-goog-api-key': provider.apiKey || process.env.GEMINI_API_KEY || '',
      'user-agent': t._internal.OFFICIAL_USER_AGENT,
    },
    body: JSON.stringify(body.request),
  });
  const text = await res.text().catch(() => '');
  console.log('\n[' + label + '] HTTP ' + res.status + (res.ok ? '' : '\n' + text.slice(0, 500)));
  return res.status;
};

async function main() {
  const prov = ((oauth.status().providers) || []).find((x) => x.id === 'antigravity');
  let r = null;
  const tried = [];
  for (const a of (prov.accounts || []).map((x) => x.account)) {
    try { r = await oauth.resolve('antigravity:' + a); break; } catch (e) { tried.push(a + ': ' + e.message); }
  }
  if (!r) { console.error('no antigravity grant resolves\n' + tried.join('\n')); process.exit(2); }
  console.log('using account under test (grant resolves):', tried.length ? 'later row' : (prov.accounts[0] || {}).account);
  const provider = { id: 'antigravity', model: (r.models[0] || {}).id || 'gemini-4-neon-high', accessToken: r.accessToken, cloudcodeUrl: r.cloudcodeUrl };

  const before = await send(provider, raw.parameters, 'raw JSON Schema (pre-fix shape)');
  const after = await send(provider, t._internal.toGeminiSchema(raw.parameters), 'lowered to the OpenAPI subset');

  const pass = !(before >= 200 && before < 300) && after >= 200 && after < 300;
  console.log('\nraw=' + before + ' lowered=' + after + ' → ' + (pass ? 'CAUSAL: the lowering is the fix' : 'INCONCLUSIVE'));
  process.exit(pass ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { console.error(e); process.exit(2); });
