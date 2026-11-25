'use strict';
// Verifies the two composer controls the user asked for are visible:
//   1. a labelled "Thinking <level>" dropdown (not a bare icon select)
//   2. a Swarm on/off toggle that persists
const WebSocket = require('ws');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (ws, method, params = {}) => new Promise((resolve, reject) => {
  const id = (rpc._id = (rpc._id || 0) + 1);
  const onMsg = (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== id) return;
    ws.off('message', onMsg);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (ws, expr) => {
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
};

(async () => {
  const list = await new Promise((res, rej) => {
    http.get('http://127.0.0.1:9333/json/list', (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res(s)); }).on('error', rej);
  }).then(JSON.parse);
  const page = list.find((t) => t.type === 'page' && /Akron Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await rpc(ws, 'Page.reload', { ignoreCache: true });
  await sleep(2600);

  // Start from a known baseline so re-runs are not order-dependent.
  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:swarmEnabled','false');
    try {
      const p = JSON.parse(localStorage.getItem('autobot:provider') || '{}');
      p.reasoningLevel = 'auto';
      localStorage.setItem('autobot:provider', JSON.stringify(p));
    } catch {}
  })()`);
  await rpc(ws, 'Page.reload', { ignoreCache: true });
  await sleep(2600);

  const pass = [];
  const fail = [];
  const ck = (name, cond, extra) => (cond ? pass : fail).push(name + (extra != null ? ' [' + extra + ']' : ''));

  // ---- 1. visibility of both controls (static) ----
  const staticState = await evaluate(ws, `(() => {
    const reason = document.querySelector('.reason-pick');
    const swarm = [...document.querySelectorAll('.composer button, .composer .icon-btn')].find((b) => /Swarm/i.test(b.getAttribute('title') || ''));
    return {
      hasReason: !!reason,
      label: reason ? (reason.querySelector('.reason-label') || {}).textContent || '' : '',
      val: reason ? (reason.querySelector('.reason-val') || {}).textContent || '' : '',
      caret: !!(reason && reason.querySelector('.reason-caret')),
      hasSelect: !!(reason && reason.querySelector('select')),
      hasSwarm: !!swarm,
      swarmPressed: swarm ? swarm.getAttribute('aria-pressed') : null,
      swarmTitle: swarm ? swarm.getAttribute('title') : '',
      inComposer: reason ? !!reason.closest('.composer') : false,
    };
  })()`);
  ck('thinking button exists', staticState.hasReason);
  ck('thinking button is labelled "Thinking"', staticState.label.trim() === 'Thinking', staticState.label);
  ck('thinking button shows current level', ['Auto', 'Low', 'Medium', 'High'].includes(staticState.val.trim()), staticState.val);
  ck('thinking button has a caret', staticState.caret);
  ck('no bare <select> left', !staticState.hasSelect);
  ck('thinking control lives in composer', staticState.inComposer);
  ck('swarm toggle exists', staticState.hasSwarm);
  ck('swarm defaults off', staticState.swarmPressed === 'false', String(staticState.swarmPressed));
  ck('swarm title explains it', /frontier/i.test(staticState.swarmTitle), staticState.swarmTitle);

  // ---- 2. opening the thinking menu ----
  await evaluate(ws, `document.querySelector('.reason-pick').click()`);
  await sleep(400);
  const menuState = await evaluate(ws, `(() => {
    const menu = document.querySelector('.reason-menu');
    const opts = menu ? [...menu.querySelectorAll('[role=option]')] : [];
    return { has: !!menu, n: opts.length, texts: opts.map((o) => (o.textContent || '').trim()) };
  })()`);
  ck('thinking menu opens', menuState.has);
  ck('thinking menu lists 4 levels', menuState.n === 4, menuState.texts.join(' | '));
  ck('thinking menu has Auto..High', ['Auto', 'Low', 'Medium', 'High'].every((n) => menuState.texts.some((t) => t.startsWith(n))), menuState.texts.join(' | '));

  // ---- 3. choosing High updates + persists ----
  await evaluate(ws, `(() => {
    const o = [...document.querySelectorAll('.reason-menu [role=option]')].find((x) => (x.textContent || '').trim().startsWith('High'));
    if (o) o.click();
  })()`);
  await sleep(500);
  const afterHigh = await evaluate(ws, `({
    label: (document.querySelector('.reason-pick .reason-val') || {}).textContent || '',
    stored: (() => { try { return JSON.parse(localStorage.getItem('autobot:provider') || '{}').reasoningLevel || ''; } catch { return ''; } })(),
    menuClosed: !document.querySelector('.reason-menu'),
  })`);
  ck('choosing High updates the label', afterHigh.label.trim() === 'High', afterHigh.label);
  ck('choosing High closes the menu', afterHigh.menuClosed);
  ck('thinking level persists with the provider', afterHigh.stored === 'high', afterHigh.stored);

  // ---- 4. swarm toggle persists + reflects pressed state ----
  await evaluate(ws, `(() => {
    const b = [...document.querySelectorAll('.composer button, .composer .icon-btn')].find((x) => /Swarm/i.test(x.getAttribute('title') || ''));
    if (b) b.click();
  })()`);
  await sleep(500);
  const afterSwarm = await evaluate(ws, `(() => {
    const b = [...document.querySelectorAll('.composer button, .composer .icon-btn')].find((x) => /Swarm/i.test(x.getAttribute('title') || ''));
    return { stored: localStorage.getItem('autobot:swarmEnabled'), pressed: b ? b.getAttribute('aria-pressed') : null, cls: b ? b.className : '' };
  })()`);
  ck('swarm on persists', afterSwarm.stored === 'true', afterSwarm.stored);
  ck('swarm shows pressed state', afterSwarm.pressed === 'true', String(afterSwarm.pressed));
  ck('swarm button shows active styling', /active/.test(afterSwarm.cls), afterSwarm.cls);

  // ---- 5. reload keeps both settings ----
  await rpc(ws, 'Page.reload', { ignoreCache: true });
  await sleep(2600);
  const afterReload = await evaluate(ws, `(() => {
    const reason = document.querySelector('.reason-pick');
    const b = [...document.querySelectorAll('.composer button, .composer .icon-btn')].find((x) => /Swarm/i.test(x.getAttribute('title') || ''));
    return {
      level: reason ? (reason.querySelector('.reason-val') || {}).textContent || '' : '',
      pressed: b ? b.getAttribute('aria-pressed') : null,
    };
  })()`);
  ck('thinking level survives reload', afterReload.level.trim() === 'High', afterReload.level);
  ck('swarm state survives reload', afterReload.pressed === 'true', String(afterReload.pressed));

  // restore defaults for other suites
  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:swarmEnabled','false');
    try {
      const p = JSON.parse(localStorage.getItem('autobot:provider') || '{}');
      p.reasoningLevel = 'auto';
      localStorage.setItem('autobot:provider', JSON.stringify(p));
    } catch {}
  })()`);

  pass.forEach((p) => console.log('  ok   ' + p));
  fail.forEach((f) => console.log('  FAIL ' + f));
  console.log('\n' + (fail.length ? 'FAILED ' : 'PASSED ') + (pass.length + fail.length) + '\n');
  ws.close();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
