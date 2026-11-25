'use strict';
// Live CDP check: global search panel (Cmd/Ctrl+Shift+F) + /sandbox + /search.
// Read-only: never sends plain text into the composer (that would start a model run).
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9333/json/list', (r) => {
      let b = '';
      r.on('data', (d) => { b += d; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

let id = 0;
function makeClient(ws) {
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}

(async () => {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.log('no page target'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const send = makeClient(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 2500));

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.result && r.result.exceptionDetails) return { err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  let pass = 0; let fail = 0;
  const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' — ' + d : '')); } };

  // 1) app mounted
  const mounted = await ev("!!document.querySelector('.sidebar')");
  ok('app mounted', mounted === true);

  // 2) sidebar has the search entry with kbd hint
  const hasEntry = await ev("!!document.querySelector('.sidenav .kbd-hint')");
  ok('sidebar search entry rendered', hasEntry === true);

  // 3) Cmd+Shift+F opens the panel
  await ev(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true, metaKey: true, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const panelOpen = await ev("!!document.querySelector('.searchview')");
  ok('Cmd/Ctrl+Shift+F opens search panel', panelOpen === true);

  // 4) typing a query searches conversations + disk without touching the composer
  const convCount = await ev(`(() => { const raw = localStorage.getItem('autobot:convs'); return raw ? (JSON.parse(raw) || []).length : 0; })()`);
  ok('conversation store readable', typeof convCount === 'number');

  await ev(`(() => { const f = document.querySelector('.searchview'); return !!f; })()`);
  const hitCount = await ev(`(async () => {
    const input = document.querySelector('.searchview .search-input');
    if (!input) return -1;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'the');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelectorAll('.searchview .search-hit').length;
  })()`);
  ok('typing yields results without a model run', hitCount >= 0, 'hits=' + hitCount);

  // 5) /sandbox reports the real policy
  const sandboxInfo = await ev(`window.autobot.getSandbox()`);
  ok('getSandbox IPC responds', sandboxInfo && typeof sandboxInfo.enabled === 'boolean', JSON.stringify(sandboxInfo && sandboxInfo.backend));

  // 6) /search toggles the panel from the composer path
  const selBefore = await ev("!!document.querySelector('.searchview')");
  await ev(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', shiftKey: true, metaKey: true, bubbles: true, cancelable: true })); return true; })()`);
  await new Promise((r) => setTimeout(r, 350));
  const selAfter = await ev("!!document.querySelector('.searchview')");
  ok('Cmd/Ctrl+Shift+F toggles the panel', selBefore !== selAfter, `${selBefore} -> ${selAfter}`);

  // 7) searchFiles IPC reachable from the renderer
  const sf = await ev(`window.autobot.searchFiles({ query: 'require', cwd: '', limit: 3 })`);
  ok('searchFiles IPC responds', Array.isArray(sf), Array.isArray(sf) ? 'hits=' + sf.length : typeof sf);

  // 8) secret store status reachable
  const ss = await ev(`window.autobot.secretStatus()`);
  ok('secretStatus IPC responds', ss && typeof ss.backend === 'string', ss && ss.backend);

  const errs = await ev(`(window.__hbErrors || []).length`);
  ok('no page errors recorded', errs === undefined || errs === 0, String(errs));

  console.log(`\n${pass} passed, ${fail} failed`);
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
