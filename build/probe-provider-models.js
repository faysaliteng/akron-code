#!/usr/bin/env electron
'use strict';
/**
 * Live probe: what model catalogs do the signed-in subscriptions actually
 * expose, and does each model carry a usable context window / thinking flag?
 *
 * Runs under `electron` because provider tokens live in safeStorage. Nothing is
 * mutated: tokens are read, GETs are issued, results are printed.
 *
 *   npx electron build/probe-provider-models.js
 */
const { app } = require('electron');
const path = require('node:path');

const T = require(path.join(__dirname, '..', 'electron', 'providertransport.js'));
const oauth = require(path.join(__dirname, '..', 'electron', 'provider-oauth.js'));

const line = (s) => console.log(s);

async function claudeModels(token) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      authorization: 'Bearer ' + token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': T._internal.claudeUa(),
      'x-app': 'cli',
    },
  });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 400), json: safe(text) };
}

async function grokModels(token) {
  const r = await fetch('https://cli-chat-proxy.grok.com/v1/models', {
    headers: T._internal.grokHeaders({ accessToken: token }),
  });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 400), json: safe(text) };
}

async function codexModels(token, accountId) {
  const h = { authorization: 'Bearer ' + token, 'user-agent': 'codex-cli/0.135.0' };
  if (accountId) h['ChatGPT-Account-Id'] = accountId;
  const r = await fetch('https://chatgpt.com/backend-api/codex/models', { headers: h });
  const text = await r.text();
  return { status: r.status, body: text.slice(0, 400), json: safe(text) };
}

function safe(t) { try { return JSON.parse(t); } catch (_) { return null; } }

function summarize(name, res) {
  line('\n### ' + name + '  HTTP ' + res.status);
  const j = res.json;
  if (!j) { line('  body: ' + res.body.replace(/\s+/g, ' ')); return; }
  const list = j.data || j.models || j.model_list || (Array.isArray(j) ? j : null);
  if (Array.isArray(list)) {
    line('  entries: ' + list.length);
    for (const m of list.slice(0, 60)) {
      line('  - ' + JSON.stringify({ id: m.id || m.model || m.slug, display: m.display_name || m.displayName || m.name }));
    }
  } else {
    line('  keys: ' + Object.keys(j).join(','));
    line('  body: ' + res.body.replace(/\s+/g, ' ').slice(0, 300));
  }
}

app.whenReady().then(async () => {
  let fails = 0;
  try {
    for (const id of ['claude', 'grok', 'chatgpt']) {
      let r;
      try { r = await oauth.resolve(id); } catch (e) {
        line('\n### ' + id + '  not signed in: ' + e.message);
        continue;
      }
      line('\n== ' + id + '  account=' + r.account + ' transport=' + r.transport + ' plan=' + (r.plan || ''));
      if (id === 'claude') summarize('claude /v1/models', await claudeModels(r.accessToken));
      if (id === 'grok') summarize('grok /v1/models', await grokModels(r.accessToken));
      if (id === 'chatgpt') summarize('codex /backend-api/codex/models', await codexModels(r.accessToken, r.accountId));
    }
    // Antigravity through the shipping normalizer.
    try {
      const { execFileSync } = require('node:child_process');
      const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], { encoding: 'utf8' }).trim();
      const blob = JSON.parse(Buffer.from(raw.replace(/^go-keyring-base64:/, ''), 'base64').toString('utf8'));
      const models = await T._internal.googleModels({ id: 'antigravity', transport: 'google', accessToken: blob.token.access_token });
      line('\n== antigravity  models=' + models.length);
      for (const m of models.slice(0, 6)) line('  - ' + JSON.stringify({ id: m.id, win: m.contextWindow, thinking: m.thinking, group: m.group }));
    } catch (e) {
      line('\n== antigravity probe failed: ' + e.message);
    }
  } catch (e) {
    fails++;
    line('ERROR ' + (e && e.stack || e));
  }
  line(fails ? '\nFAILED' : '\nDONE');
  app.exit(fails ? 1 : 0);
});
