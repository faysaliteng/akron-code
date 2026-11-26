// Live probe: the orchestrator pool must never carry a turn on a row its own
// gateway disowns. The measured failure (2026-11-26) was a stale row pointing at
// Ollama on 11434 asking for `claude-fable-5-2`, which produced "model
// 'claude-fable-5-2' not found" — indistinguishable from a dead Claude plan.
// Here we put that exact row in the live pool, run one turn through a real
// model, and require:
//   * a `notice` that names the dropped row and the gateway that disowned it,
//   * the turn completing on the model the gateway actually serves.
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); } };

async function findPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    ws.on('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}
const ev = (cdp, expression) => cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  .then((r) => (r.exceptionDetails ? { __err: r.exceptionDetails.text, detail: r.exceptionDetails.exception && r.exceptionDetails.exception.description } : r.result.value));

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(1200);

  const before = await ev(cdp, `window.autobot.getOrchestrator()`);
  console.log('previous orchestrator:', JSON.stringify(before && before.providers && before.providers.map((p) => p.model)));

  const STALE = { id: 'probe-stale', name: 'Provider 1', baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'claude-fable-5-2', tier: 'heavy' };
  const GOOD = { id: 'probe-good', name: 'Ollama', baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'gemma4:latest', tier: 'heavy' };

  // Install the live pool: a stale row FIRST and active, a served row second.
  const seeded = await ev(cdp, `window.autobot.setOrchestrator(${JSON.stringify({ enabled: true, providers: [STALE, GOOD], activeIndex: 0 })})`);
  ok('pool seeded with the stale row active', seeded && (seeded.ok === undefined || seeded.ok === true), seeded);

  // Collect every event this run emits.
  const collected = await ev(cdp, `(async () => {
    const events = [];
    const off = window.autobot.onEvent((e) => { if (e && e.type) events.push({ type: e.type, text: e.text || '', message: e.message || '' }); });
    const runId = 'probe-orch-prune-' + Date.now();
    const res = await window.autobot.run({
      runId,
      messages: [{ role: 'user', content: 'Reply with exactly one word: ready' }],
      provider: ${JSON.stringify(GOOD)},
      orchestrator: ${JSON.stringify({ enabled: true, providers: [STALE, GOOD], activeIndex: 0 })},
      permissions: 'read-only',
      maxSteps: 1,
      convId: 'probe-orch-prune',
      title: 'probe',
    });
    off();
    return { res, events };
  })()`);

  const events = (collected && collected.events) || [];
  const notices = events.filter((e) => e.type === 'notice');
  const complete = events.filter((e) => e.type === 'complete');
  const errors = events.filter((e) => e.type === 'error');
  console.log('event types:', events.map((e) => e.type).join(','));
  console.log('notices:', JSON.stringify(notices.map((n) => n.text), null, 1));

  const dropNotice = notices.find((n) => /claude-fable-5-2/.test(n.text) && /not one of them|serves/.test(n.text));
  ok('a notice names the dropped model and why', !!dropNotice, notices.map((n) => n.text));
  ok('the notice names the gateway', !!dropNotice && /11434/.test(dropNotice.text));
  ok('the notice says the saved row is untouched', !!dropNotice && /untouched/i.test(dropNotice.text));
  ok('no invented failure for the kept row', !notices.some((n) => /gemma4/i.test(n.text)), notices.map((n) => n.text));

  ok('the turn completed', complete.length > 0, events.filter((e) => e.type === 'error').map((e) => e.message));
  ok('no fatal error', errors.length === 0, errors.map((e) => e.message));

  // The stored config must still contain the row: pruning is per-turn, never a
  // silent rewrite of the user's settings.
  const after = await ev(cdp, `window.autobot.getOrchestrator()`);
  const stillThere = (after.providers || []).some((p) => p.model === 'claude-fable-5-2');
  ok('the saved stale row is not deleted', stillThere, (after.providers || []).map((p) => p.model));

  // Restore whatever the user had.
  await ev(cdp, `window.autobot.setOrchestrator(${JSON.stringify(before)})`);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  cdp.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('PROBE ERROR', e && e.stack || e); process.exit(2); });
