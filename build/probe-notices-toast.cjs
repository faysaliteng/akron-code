// Prove, against the running renderer, that (a) every provider notice can be
// dismissed and (b) the context-pressure toast appears at the right pressure,
// can be closed, and never sits on top of the composer.
//
//   node build/probe-notices-toast.cjs [port]
'use strict';

const WebSocket = require('/Users/saimon/Documents/Default Project/autobot/node_modules/ws');
const port = Number(process.argv[2] || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, c, d) => { results.push({ n, c: !!c, d: d === undefined ? '' : String(d).slice(0, 400) }); };

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
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
  const reload = async (waitMs) => {
    await send('Page.reload', { ignoreCache: false });
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const ready = await evalJS(`!!document.querySelector('.app') && !!document.querySelector('.composer')`);
        if (ready) return true;
      } catch (_) { /* still navigating */ }
    }
    return false;
  };
  return { send, evalJS, reload, close: () => ws.close() };
}

// ---------------------------------------------------------------- toast state
const seed = async (page, ctxTokens, model) => {
  await page.evalJS(`localStorage.setItem('autobot:lastUsage', ${JSON.stringify(JSON.stringify({ context_tokens: ctxTokens, model, at: Date.now() }))})`);
  const loaded = await page.reload();
  ok('renderer reloaded with the seeded usage record', loaded);
  return loaded;
};

const toastInfo = (page) => page.evalJS(`(() => {
  const el = document.querySelector('.ctx-toast');
  if (!el) return { present: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const x = el.querySelector('.ctx-toast-x');
  const cmp = document.querySelector('.composer');
  const cr = cmp && cmp.getBoundingClientRect();
  return {
    present: true,
    tone: el.className,
    title: (el.querySelector('.ctx-toast-title') || {}).textContent || '',
    sub: (el.querySelector('.ctx-toast-sub') || {}).textContent || '',
    hasClose: !!x,
    closeLabel: x && (x.getAttribute('aria-label') || ''),
    position: cs.position,
    bottom: cs.bottom,
    zIndex: cs.zIndex,
    rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
    composerRect: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom) } : null,
    // The toast must be on screen and must not cover the message box.
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.width > 0,
    overlapsComposer: !!(cr && !(r.bottom <= cr.top || r.top >= cr.bottom)),
    text: el.textContent.replace(/\\s+/g, ' ').trim(),
  };
})()`);

const noticeInfo = (page) => page.evalJS(`(() => {
  const all = [...document.querySelectorAll('.prov-notice')];
  return all.map((el) => {
    const x = el.querySelector('.prov-notice-x');
    return {
      text: (el.querySelector('.prov-notice-text') || el).textContent.replace(/\\s+/g, ' ').trim().slice(0, 160),
      warn: el.className.includes('warn'),
      hasClose: !!x,
      closeLabel: x && (x.getAttribute('aria-label') || x.getAttribute('title') || ''),
      visible: el.getBoundingClientRect().height > 0,
    };
  });
})()`);

(async () => {
  const page = await connect();

  // ---------------------------------------------------------------- A. toast
  // 1M-window model (gemini-4 → 1,048,576 by the offline rule), so 78 % of the
  // window is a plain number choice, not a provider read.
  const WIN = 1048576;
  ok('no toast while the conversation is small',
    !(await toastInfo(page)).present);

  await seed(page, Math.round(WIN * 0.5), 'gemini-4-neon-high');
  let t = await toastInfo(page);
  ok('50 % of the window produces no toast', !t.present, t.text || '');

  await seed(page, Math.round(WIN * 0.78), 'gemini-4-neon-high');
  t = await toastInfo(page);
  ok('78 % of the window shows the toast', !!t.present);
  ok('the first warning is the warm tone', /warm/.test(t.tone || ''), t.tone);
  ok('it reports the share of the window, not a provider error string',
    /\d+% of the window used/.test(t.sub || ''), t.sub);
  ok('the number it prints matches the tone (78 → warm, never "90%" + warm)',
    !/^9\d%/.test((t.sub || '').trim()), t.sub);
  ok('no raw token-limit wording is shown',
    !/token limit|max_tokens|context_length_exceeded|exceeded your/i.test(t.text || ''), t.text);
  ok('it has a close button', !!t.hasClose, t.closeLabel);
  ok('the close button is labelled for screen readers', /dismiss/i.test(t.closeLabel || ''), t.closeLabel);
  ok('it is fixed-position and docked above the message box', t.position === 'fixed' && parseInt(t.bottom, 10) >= 18, t.position + '/' + t.bottom);
  ok('it is on screen', !!t.inViewport, JSON.stringify(t.rect));
  ok('it does not cover the composer', !t.overlapsComposer,
    'toast ' + JSON.stringify(t.rect) + ' vs composer ' + JSON.stringify(t.composerRect));

  // Close it with a real click event on the button.
  await page.evalJS(`document.querySelector('.ctx-toast-x').click()`);
  await sleep(300);
  t = await toastInfo(page);
  ok('clicking the close button hides the toast', !t.present);

  // 95 % → the escalation must speak even though 78 % was dismissed (a reload
  // clears component state, so this asserts the tone itself).
  await seed(page, Math.round(WIN * 0.95), 'gemini-4-neon-high');
  t = await toastInfo(page);
  ok('95 % of the window shows the toast', !!t.present);
  ok('the escalation is the hot tone', /hot/.test(t.tone || ''), t.tone);
  ok('the hot wording differs from the warm wording', !/getting long/i.test(t.title || ''), t.title);
  ok('95 % prints 95 %', /95% of the window used/.test(t.sub || ''), t.sub);
  ok('the hot toast still does not cover the composer', !t.overlapsComposer);
  await page.evalJS(`document.querySelector('.ctx-toast-x').click()`);
  await sleep(300);
  ok('the hot toast can also be dismissed', !(await toastInfo(page)).present);

  // A different conversation length re-arms it (the renderer restarts clean).
  await seed(page, null, 'gemini-4-neon-high');
  ok('clearing usage silences the toast', !(await toastInfo(page)).present);

  // ---------------------------------------------------------------- B. notices
  const notices = await noticeInfo(page);
  ok('the idle app shows no provider notice', notices.length === 0, notices.map((n) => n.text).join(' | '));

  // Now earn a real notice from the app itself: the model picker's
  // "Import accounts from this Mac" always reports what the scan found (it is
  // idempotent — a second scan imports nothing), so it renders a genuine
  // .prov-notice through the shared component, with no fixtures involved.
  const openPicker = async () => {
    await page.evalJS(`document.querySelector('.model-pill').click()`);
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if (await page.evalJS(`!!document.querySelector('.model-menu')`)) return true;
    }
    return false;
  };
  const clickImport = () => page.evalJS(`(() => {
    const menu = document.querySelector('.model-menu');
    if (!menu) return 'no menu';
    const btn = [...menu.querySelectorAll('button.model-opt')]
      .find((b) => /Import accounts from this Mac|Scanning this Mac/.test(b.textContent || ''));
    if (!btn) return 'no import button';
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return 'clicked';
  })()`);
  const waitNotice = async () => {
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      const n = await noticeInfo(page);
      if (n.length) return n;
    }
    return [];
  };

  ok('the model picker opens', await openPicker());
  ok('the picker offers "Import accounts from this Mac"',
    (await clickImport()) === 'clicked');
  let shown = await waitNotice();
  ok('a real notice is rendered by the app', shown.length > 0, JSON.stringify(shown));
  if (shown.length) {
    const n = shown[0];
    ok('the notice names what the scan did', /Imported \d+/.test(n.text), n.text);
    ok('the notice is visible', !!n.visible);
    ok('the notice has a close button', !!n.hasClose, n.closeLabel);
    ok('the close button is labelled for screen readers', /dismiss/i.test(n.closeLabel || ''), n.closeLabel);

    await page.evalJS(`document.querySelector('.prov-notice-x').click()`);
    await sleep(400);
    const after = await noticeInfo(page);
    ok('clicking the close button hides the notice', after.length === 0,
      after.map((n) => n.text).join(' | '));

    // A dismissal belongs to that mounted banner, not to the message forever:
    // closing and reopening the picker remounts the component, so a later scan
    // reports itself again instead of being swallowed by the old dismissal.
    await page.evalJS(`document.querySelector('.model-pill').click()`);
    await sleep(300);
    ok('the picker reopens', await openPicker());
    ok('the import button is there again', (await clickImport()) === 'clicked');
    const again = await waitNotice();
    ok('a later, fresh notice is not suppressed by the old dismissal', again.length > 0,
      JSON.stringify(again));
  }
  await page.evalJS(`(() => {
    const menu = document.querySelector('.model-menu');
    if (menu) document.querySelector('.model-pill').click();
  })()`);
  await sleep(200);

  page.close();

  console.log('\n=== notices + context toast ===');
  let bad = 0;
  for (const r of results) {
    if (!r.c) bad++;
    console.log((r.c ? 'PASS ' : 'FAIL ') + r.n + (r.d ? '  — ' + r.d : ''));
  }
  console.log(bad ? `\n${bad} FAILED of ${results.length}` : `\nall ${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', (e && e.stack) || e); process.exit(2); });
