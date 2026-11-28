// Prove, against the running renderer, that the chat notice bar — the one that
// carries "Left 1 orchestrator model out of this turn — … needs to be signed in
// again. The saved row is untouched…" — can be closed, and that closing it does
// not swallow the next, different notice.
//
//   node build/probe-noticebar.cjs [port]
//
// Driven through the app's own `/goal` slash command, which sets the same
// `notice` state the orchestrator drop notice uses. No fixtures, no patching.
'use strict';

const WebSocket = require('ws');
const port = Number(process.argv[2] || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, c, d) => { results.push({ n, c: !!c, d: d === undefined ? '' : String(d).slice(0, 400) }); };

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
  if (!page) throw new Error('no renderer target on port ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
  let id = 0; const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await send('Runtime.enable');
  await send('Page.enable');
  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result && r.result.value;
  };
  const reload = async () => {
    await send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        if (await evalJS(`!!document.querySelector('.app') && !!document.querySelector('.composer textarea, .composer [contenteditable="true"]')`)) return true;
      } catch (_) {}
    }
    return false;
  };
  return { evalJS, reload, close: () => ws.close() };
}

const BAR = `(() => {
  const el = document.querySelector('.noticebar');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = el.querySelector('.noticebar-x');
  const xr = x ? x.getBoundingClientRect() : null;
  return {
    text: (el.querySelector('.noticebar-text') || el).textContent.replace(/\\s+/g, ' ').trim(),
    visible: r.width > 0 && r.height > 0 && r.top >= 0,
    hasClose: !!x,
    closeLabel: x ? (x.getAttribute('aria-label') || x.getAttribute('title') || '') : '',
    closeHit: !!xr && xr.width >= 16 && xr.height >= 16,
    closeInside: !!xr && xr.top >= r.top - 1 && xr.right <= r.right + 1,
  };
})()`;

// Type a slash command into the app's composer and submit it.
const runSlash = (cmd) => `(async () => {
  const ta = document.querySelector('.composer textarea, .composer [contenteditable="true"]');
  if (!ta) return 'no composer';
  const isTa = ta.tagName === 'TEXTAREA';
  if (isTa) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(cmd)});
  } else {
    ta.textContent = ${JSON.stringify(cmd)};
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return 'sent';
})()`;

(async () => {
  const page = await connect();
  ok('the renderer is up', await page.reload());

  // Nothing should be showing a bar yet.
  ok('no notice bar on a fresh renderer', (await page.evalJS(BAR)) === null);

  const sent = await page.evalJS(runSlash('/goal probe-notice-dismiss'));
  ok('/goal reaches the composer', sent === 'sent', sent);

  let bar = null;
  for (let i = 0; i < 40; i++) { await sleep(150); bar = await page.evalJS(BAR); if (bar) break; }
  ok('the app renders a notice bar', !!bar, JSON.stringify(bar));
  if (!bar) {
    // Bail out with a report rather than a hang.
    report(); process.exit(1);
  }
  ok('the bar carries the message', /Goal: probe-notice-dismiss/.test(bar.text), bar.text);
  ok('the bar is visible', !!bar.visible);
  ok('the bar has a close button', !!bar.hasClose);
  ok('the close button is labelled for screen readers', /dismiss/i.test(bar.closeLabel || ''), bar.closeLabel);
  ok('the close button is a real hit target (>=16px)', !!bar.closeHit);
  ok('the close button sits inside the bar', !!bar.closeInside);

  await page.evalJS(`document.querySelector('.noticebar-x').click()`);
  await sleep(350);
  ok('clicking close hides the bar', (await page.evalJS(BAR)) === null);

  // A dismissal belongs to that message. A different notice must still speak.
  await page.evalJS(runSlash('/goal probe-notice-second'));
  let bar2 = null;
  for (let i = 0; i < 40; i++) { await sleep(150); bar2 = await page.evalJS(BAR); if (bar2) break; }
  ok('a different notice is not swallowed by the old dismissal', !!bar2, JSON.stringify(bar2));
  ok('the new bar shows the new text', !!bar2 && /probe-notice-second/.test(bar2.text), bar2 && bar2.text);

  // And the bar must not push the composer off screen or overlap the toast slot.
  const geo = await page.evalJS(`(() => {
    const b = document.querySelector('.noticebar');
    const c = document.querySelector('.composer');
    if (!b || !c) return null;
    const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const t = document.querySelector('.ctx-toast');
    const tr = t ? t.getBoundingClientRect() : null;
    return {
      barBottom: Math.round(br.bottom), composerTop: Math.round(cr.top),
      overlap: br.bottom > cr.top + 1,
      toastOverlap: !!tr && tr.bottom > br.top && tr.top < br.bottom && tr.left < br.right && tr.right > br.left,
      barHeight: Math.round(br.height),
    };
  })()`);
  ok('the bar sits above the composer, no overlap', !!geo && !geo.overlap, JSON.stringify(geo));
  ok('the bar is one line tall-ish, not a wall', !!geo && geo.barHeight <= 90, geo && geo.barHeight);

  report();
  page.close();
  process.exit(results.some((r) => !r.c) ? 1 : 0);
})().catch((e) => { console.error('PROBE ERROR', e && e.stack || e); process.exit(2); });

function report() {
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.c) { pass++; console.log('  ok   ' + r.n); }
    else { fail++; console.log('  FAIL ' + r.n + (r.d ? '  -> ' + r.d : '')); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
}
