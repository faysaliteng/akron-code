// Proof: the app authenticates to the local FreeLLMAPI router with its unified
// key, end to end — without any manual seeding of the renderer profile.
//
// The router at :3001 rejects every request without a bearer (401), so
//   (a) the picker listing its catalog, and
//   (b) a real assistant answer,
// are causal proof the app sent the stored key. The key reaches the renderer the
// production way: the local-only settings file the main process owns.
//
// Usage: node build/probe-freellm-key.cjs [port] [baseURL] [model]
//   GW_KEY=<unified key>  (required)
const WebSocket = require('../node_modules/ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = Number(process.argv[2] || 9444);
const BASEURL = process.argv[3] || 'http://localhost:3001/v1';
const MODEL = process.argv[4] || 'auto:fast';
const KEY = process.env.GW_KEY || '';
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The pool the user ticked is real state, not test furniture. Parking it for
// the turn is unavoidable (the turn must use the single keyed provider), so a
// copy goes to disk first and is put back on every exit path — including a
// failed run. A previous version restored only on success and left the user
// with an empty pool when a check threw.
const ORCH_BACKUP = path.join(os.homedir(), '.autobot', 'orchestrator.preprobe.json');
let cdpRef = null;
let parkedOrch = null;
const poolWorthKeeping = (o) => !!(o && Array.isArray(o.providers) && (o.providers.length || o.enabled));
async function restorePool() {
  if (!poolWorthKeeping(parkedOrch)) return;
  if (cdpRef) {
    try {
      await ev(cdpRef, `window.autobot.setOrchestrator(${JSON.stringify(parkedOrch)}).then(() => 'restored')`);
      console.log('orchestrator pool restored: ' + parkedOrch.providers.length + ' rows, enabled=' + !!parkedOrch.enabled);
      return;
    } catch (e) {
      console.error('pool restore via app failed (' + e.message + ') — backup kept at ' + ORCH_BACKUP);
      return;
    }
  }
  console.error('no CDP session left to restore the pool — backup kept at ' + ORCH_BACKUP);
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail).slice(0, 220) });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 220) : ''));
};

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target on ' + BASE);
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
        return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
  return r.result.value;
}

(async () => {
  if (!KEY) { console.error('GW_KEY is required'); process.exit(2); }

  // 1. The endpoint must actually be gated, otherwise the rest proves nothing.
  const unauth = await fetch(BASEURL.replace(/\/+$/, '') + '/models').then((r) => r.status).catch((e) => 'err:' + e.message);
  check('router rejects an unauthenticated /models', unauth === 401, 'status ' + unauth);

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  cdpRef = cdp;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 2. Wipe only the renderer's own copy, so the adoption path (main-process
  //    settings file → renderer) is what puts the key back. A profile that has
  //    never seen this endpoint behaves exactly like this.
  await ev(cdp, `(() => {
    localStorage.removeItem('autobot:provider');
    localStorage.removeItem('autobot:providerKeys');
    return 'cleared';
  })()`);
  await cdp.send('Page.reload');
  await sleep(6000);

  const held = await ev(cdp, `(() => {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('autobot:provider') || '{}'); } catch (_) {}
    let map = {};
    try { map = JSON.parse(localStorage.getItem('autobot:providerKeys') || '{}'); } catch (_) {}
    const keys = Object.keys(map);
    const hit = keys.find((k) => /:3001\\/v1\\/?$/.test(k)) || ${JSON.stringify(BASEURL)};
    return {
      base: p.baseURL || '',
      model: p.model || '',
      keyLen: String(p.apiKey || '').length,
      mapBases: keys,
      mapKeyLen: String(map[hit] || '').length,
    };
  })()`);
  check('the app adopted the saved endpoint', /:3001\/v1\/?$/.test(held.base), held.base);
  check('the app adopted the saved key', held.keyLen === KEY.length, 'keyLen ' + held.keyLen);
  check('the app kept the model the user saved', held.model === MODEL, 'model ' + JSON.stringify(held.model));
  check('the per-endpoint key map carries the key', held.mapKeyLen === KEY.length, 'mapKeyLen ' + held.mapKeyLen + ' bases ' + JSON.stringify(held.mapBases).slice(0, 120));

  // 2b. Prove the *key* is what answers, not the saved orchestrator pool: park
  //     the pool for this run so the turn must use the single provider above,
  //     then put the user's pool back afterwards.
  parkedOrch = await ev(cdp, `window.autobot.getOrchestrator()`);
  if (poolWorthKeeping(parkedOrch)) {
    try {
      fs.mkdirSync(path.dirname(ORCH_BACKUP), { recursive: true });
      fs.writeFileSync(ORCH_BACKUP, JSON.stringify(parkedOrch, null, 2) + '\n', { mode: 0o600 });
    } catch (e) { console.error('could not write the pool backup: ' + e.message); }
  }
  await ev(cdp, `window.autobot.setOrchestrator({ enabled: false, providers: [], activeIndex: -1 }).then(() => 'parked')`);
  await cdp.send('Page.reload');
  await sleep(6000);

  // 3. The picker asks the keyed router for its catalog and lists it.
  const picked = await ev(cdp, `(async () => {
    const pill = document.querySelector('.model-pill');
    if (!pill) return { err: 'no model pill' };
    pill.click();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const rows = [...document.querySelectorAll('.model-menu .model-opt')];
      const names = rows.map((r) => (r.querySelector('.model-opt-name') || {}).textContent || '');
      if (names.length > 40) {
        const menu = document.querySelector('.model-menu');
        const head = (menu.querySelector('.model-menu-head') || {}).textContent || '';
        const live = rows.filter((r) => /·\\s*live$/.test(((r.querySelector('.model-opt-prov') || {}).textContent || '')));
        return { count: names.length, head, live: live.length, sample: names.slice(0, 8), hasAuto: names.includes('auto') };
      }
    }
    const rows = [...document.querySelectorAll('.model-menu .model-opt')];
    return { count: rows.length, head: '', live: 0, sample: rows.slice(0, 8).map((r) => (r.querySelector('.model-opt-name') || {}).textContent || '') };
  })()`);
  check('the picker lists the router catalog', picked && picked.count > 40, 'rows ' + (picked && picked.count));
  check('the catalog rows are marked as a live local gateway', picked && picked.live >= 20, 'live rows ' + (picked && picked.live));
  check('the router serves the selected alias', !!(picked && picked.sample && picked.sample.includes(MODEL)), picked && JSON.stringify(picked.sample));
  await ev(cdp, `(() => { document.body.click(); document.querySelector('.model-pill') && document.querySelector('.model-pill').click(); return 'closed'; })()`);
  await sleep(600);

  // 4. A real turn. The only way this returns text is a 200 from the keyed
  //    router, because step 1 showed every keyless call is 401.
  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) b.click();
    return 'new';
  })()`);
  await sleep(2200);

  const SENTINEL = 'WIRED-' + Date.now().toString(36).toUpperCase();
  const PROMPT = 'Reply with exactly this token and nothing else: ' + SENTINEL;
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus(); return 'typed';
  })()`);
  await sleep(300);
  await ev(cdp, `(() => {
    document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return 'sent';
  })()`);

  let snap = null;
  let prevText = '';
  for (let i = 0; i < 210; i++) {
    await sleep(1000);
    snap = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      return {
        text: el ? (el.textContent || '').trim() : '',
        err: err ? (err.textContent || '').trim().slice(0, 300) : null,
        streaming: !!document.querySelector('.streaming, .thinking'),
      };
    })()`);
    if (snap.err) break;
    if (snap.text && snap.text === prevText && !snap.streaming && snap.text.includes(SENTINEL)) break;
    prevText = snap.text;
  }

  check('the app completed a real turn through the keyed router', !!(snap && snap.text), snap ? (snap.text || '').slice(0, 120) : 'no snapshot');
  check("the answer is the model's reply, not a 401", !!(snap && snap.text.includes(SENTINEL)), snap ? snap.text.slice(0, 160) : '');
  check('no error banner', !(snap && snap.err), snap && snap.err ? snap.err : 'none');
  check('no markup leak in the banner', !(snap && snap.err && /<[a-z!\/][^>]*>/i.test(snap.err)), 'leak:false');

  await restorePool();
  cdp.close();
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error('FREELLM KEY PROBE FAILED:', e.message);
  await restorePool().catch(() => {});
  if (cdpRef) cdpRef.close();
  process.exit(1);
});
