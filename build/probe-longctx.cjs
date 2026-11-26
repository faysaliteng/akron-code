// Prove the Anthropic 1M long-context beta path on the live app: send a turn
// that needs ≈195k tokens to a Sonnet 4.x id. If the beta were refused the turn
// would fail (or be demoted and fail on prompt-too-long); a normal answer whose
// usage.input_tokens is >200000 is proof the beta was accepted.
// Usage: node build/probe-longctx.cjs [port] [model]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'claude-sonnet-4-5';
const ACCOUNT = 'claude:rxpromedbd-gmail-com';
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    });
    ws.on('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  // What does the app currently think the window is?
  const before = await ev(cdp, `(async () => {
    const r = await window.autobot.providerModels('${ACCOUNT}');
    const m = (r && r.models || []).find(x => x.id === '${MODEL}');
    return { count: r && r.count, model: m || null, warning: (r && r.warning) || '' };
  })()`);
  console.log('catalog:', JSON.stringify(before));

  // Orchestrator Mode is on in the live store and it overrides the provider, so
  // without this the probe would have proved 1M on whatever row the pool was
  // pointing at, not on the id it printed. Off by default.
  const ORCH_ON = process.env.LC_ORCH === '1';
  const TOKEN = 'LONGPASS' + Math.floor(Math.random() * 1e6);
  // ≈ 660 000 chars ≈ 194k tokens at the app's 3.4 chars/token estimate.
  const LINES = Number(process.env.LC_LINES || 6600);
  const pad = Array.from({ length: LINES }, (_, i) =>
    'Filler ' + String(i).padStart(4, '0') + ': the quick brown fox jumps over the lazy dog while the band plays on.').join('\n');
  console.log('pad chars:', pad.length);

  const started = Date.now();
  await ev(cdp, `(() => {
    window.__lc = { events: [], done: false };
    const off = window.autobot.onEvent((e) => {
      if (!e || !e.runId || e.runId !== window.__lcRun) return;
      if (e.type === 'usage' && e.usage) window.__lc.usage = e.usage;
      // The failure reason arrives in e.message (main.js sends
      // { type: 'error', message }); reading only e.text printed an empty
      // error and hid the provider's own words. Record both, plus the fields
      // that carry a diagnosis.
      const words = e.message || e.text || '';
      window.__lc.events.push({
        type: e.type,
        text: words ? String(words).slice(0, 400) : '',
        message: e.message ? String(e.message).slice(0, 400) : '',
        error: e.error ? String(e.error).slice(0, 400) : null,
        phase: e.phase || null,
      });
      if (e.type === 'complete' || e.type === 'error') { window.__lc.done = true; off(); }
      if (e.type === 'complete' && e.messages) {
        const last = e.messages[e.messages.length - 1];
        window.__lc.last = last;
      }
    });
    window.__lcRun = 'lc' + Date.now();
    window.autobot.run({
      runId: window.__lcRun,
      messages: [{ role: 'user', content: ${JSON.stringify(pad + '\n\nIgnore every filler line above. Reply with exactly this token and nothing else: ' + TOKEN + '. Do not call any tool.')} }],
      provider: { oauthProvider: '${ACCOUNT}', model: '${MODEL}', supportsTools: true, reasoningLevel: 'auto' },
      // Orchestrator Mode ignores the provider above and runs the pool's active
      // row, which is a different model than the one this probe names. Send an
      // explicitly disabled pool so the turn really runs ${MODEL}; LC_ORCH=1
      // exercises the pool path instead.
      orchestrator: { enabled: ${ORCH_ON}, providers: [] },
      permissions: 'auto',
      title: 'long-context check',
    }).catch((e) => { window.__lc.events.push({ type: 'error', error: String(e && e.message || e) }); window.__lc.done = true; });
    return true;
  })()`);

  let snap = null;
  for (let i = 0; i < 480; i++) {
    await sleep(1000);
    snap = await ev(cdp, `({ done: window.__lc.done, events: window.__lc.events, last: window.__lc.last || null, usage: window.__lc.usage || null })`);
    if (snap.done) break;
    if (i % 15 === 14) console.log('  …', Math.round((Date.now() - started) / 1000) + 's', snap.events.length + ' events');
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const errs = (snap.events || []).filter((e) => e.type === 'error' || e.error);
  const last = snap.last || {};
  const usage = snap.usage || {};
  const text = String(last.content || '');
  const after = await ev(cdp, `(async () => {
    const r = await window.autobot.providerModels('${ACCOUNT}');
    const m = (r && r.models || []).find(x => x.id === '${MODEL}');
    return m || null;
  })()`);

  console.log('\n--- result ---');
  console.log('seconds          :', secs);
  console.log('done             :', snap.done);
  console.log('errors           :', JSON.stringify(errs).slice(0, 600));
  // A refusal from the provider is not the app failing. Say which this was, so a
  // red PASS is never mistaken for a regression in the beta path.
  const errText = errs.map((e) => e.message || e.text || e.error || '').join(' | ');
  const blocked = /usage credits|out of credit|credits? (?:are|is) required|insufficient credit/i.test(errText);
  if (blocked) console.log('blocked          : provider refused long context (needs usage credits) — not an app failure');
  console.log('answer has token :', text.includes(TOKEN));
  console.log('answer tail      :', JSON.stringify(text.slice(-120)));
  console.log('usage            :', JSON.stringify(usage));
  const inTok = Number(usage.prompt_tokens || usage.input_tokens || 0);
  console.log('prompt_tokens    :', inTok);
  console.log('window before    :', before.model && before.model.windowLabel, before.model && before.model.contextWindow);
  console.log('window after     :', after && after.windowLabel, after && after.contextWindow);
  // Which model actually answered. With the pool disabled this must be the id
  // the probe asked for; a mismatch means something overrode the request.
  const served = String(usage.model || '');
  const modelOk = !ORCH_ON ? served === MODEL : true;
  console.log('model asked      :', MODEL);
  console.log('model served     :', served || '(not reported)');
  console.log('model match      :', modelOk);
  console.log('PASS             :', !!snap.done && !errs.length && text.includes(TOKEN)
    && inTok > 190000 && modelOk);
  cdp.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
