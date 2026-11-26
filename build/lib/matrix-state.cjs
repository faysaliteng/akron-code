// Snapshot and restore the user's real app state around a smoke run.
//
//   node build/lib/matrix-state.cjs save <port> <file>
//   node build/lib/matrix-state.cjs restore <port> <file>
//   node build/lib/matrix-state.cjs show <port>
//
// Probes need the composer pointed at their own provider/model for one turn, and
// UI probes click model rows. Either way the app ends on a profile the user did
// not choose. Per-probe restore exists (build/lib/preserve-provider.cjs), but a
// probe that crashes before it arms, or one added later, can still leak. The
// matrix runner therefore wraps the whole run in this snapshot too.
//
// The snapshot holds an API key, so it is written 0600 in a private temp dir.
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', '..', 'node_modules', 'ws'));

const LS_KEYS = ['autobot:provider', 'autobot:providerKeys', 'autobot:activeId', 'autobot:lastUsage'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
  if (!page) throw new Error('no renderer target on port ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pend.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result && r.result.value;
  };
  return { send, ev, close: () => ws.close() };
}

const describe = (p) => p ? `${p.baseURL || '(oauth)'} / ${p.model || ''} / key ${((p.apiKey) || '').length}` : '(none)';

(async () => {
  const [cmd, portArg, file] = process.argv.slice(2);
  const port = Number(portArg || 9444);
  const cdp = await connect(port);

  if (cmd === 'show') {
    const now = await cdp.ev(`(async () => {
      const p = JSON.parse(localStorage.getItem('autobot:provider') || 'null');
      const s = await window.autobot.getSettings();
      const o = await window.autobot.getOrchestrator();
      return { renderer: p, main: s && s.provider, pool: o && { enabled: o.enabled, models: (o.providers || []).map(r => r.model) } };
    })()`);
    console.log('renderer:', describe(now.renderer));
    console.log('main:    ', describe(now.main));
    console.log('pool:    ', JSON.stringify(now.pool));
    cdp.close();
    return;
  }

  if (cmd === 'save') {
    const snap = await cdp.ev(`(async () => {
      const keys = ${JSON.stringify(LS_KEYS)};
      const ls = {};
      for (const k of keys) ls[k] = localStorage.getItem(k);
      const s = await window.autobot.getSettings();
      const o = await window.autobot.getOrchestrator();
      return { ls, provider: (s && s.provider) || null, orchestrator: o || null, activeId: localStorage.getItem('autobot:activeId') };
    })()`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(snap, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log('saved  ' + describe(snap.provider) + '  pool ' + ((snap.orchestrator && snap.orchestrator.providers) || []).length);
    cdp.close();
    return;
  }

  if (cmd === 'restore') {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    await cdp.ev(`(async () => {
      const prev = ${JSON.stringify(snap.ls || {})};
      for (const k of Object.keys(prev)) {
        if (prev[k] === null) localStorage.removeItem(k);
        else localStorage.setItem(k, prev[k]);
      }
      const p = ${JSON.stringify(snap.provider)};
      if (p) await window.autobot.setSettings({ provider: p });
      const o = ${JSON.stringify(snap.orchestrator)};
      if (o && o.providers) await window.autobot.setOrchestrator(o);
      return 'restored';
    })()`);
    await cdp.send('Page.reload');
    await sleep(5000);
    const now = await cdp.ev(`(async () => {
      const p = JSON.parse(localStorage.getItem('autobot:provider') || 'null');
      const s = await window.autobot.getSettings();
      const o = await window.autobot.getOrchestrator();
      return { renderer: p, main: s && s.provider, pool: o && { enabled: o.enabled, models: (o.providers || []).map(r => r.model) } };
    })()`);
    const want = snap.provider || {};
    const same = (a, b) => (a || '') === (b || '');
    const good = same(now.main && now.main.baseURL, want.baseURL)
      && same(now.main && now.main.model, want.model)
      && ((now.main && now.main.apiKey) || '').length === ((want.apiKey) || '').length
      && same(now.renderer && now.renderer.baseURL, want.baseURL)
      && same(now.renderer && now.renderer.model, want.model);
    console.log('restored ' + describe(now.main) + '  pool ' + ((now.pool && now.pool.models) || []).length + (good ? '  OK' : '  MISMATCH'));
    cdp.close();
    process.exit(good ? 0 : 1);
  }

  console.error('usage: matrix-state.cjs save|restore|show <port> [file]');
  cdp.close();
  process.exit(2);
})().catch((e) => { console.error('matrix-state failed:', (e && e.message) || e); process.exit(2); });
