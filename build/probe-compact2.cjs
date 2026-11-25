// Tight-grained check that the compaction/trim notice actually reaches the DOM.
// Usage: node build/probe-compact2.cjs [port] [model] [account] [transport] [chars]
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'tab_flash_lite_preview';
const ACCOUNT = process.argv[4] || 'antigravity:6969loavbal-gmail-com';
const TRANSPORT = process.argv[5] || 'google';
const CHARS = Number(process.argv[6] || 30000);
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
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
    });
    ws.on('open', () => resolve({
      send(method, params) { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }); },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'eval error');
  return r.result.value;
}

const TOKEN = 'CMPCT2' + Math.floor(Math.random() * 1e6);
const FILLER = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
function buildPrompt() {
  const lines = []; let size = 0; let i = 0;
  while (size < CHARS) { const line = 'filler line ' + (++i) + ': ' + FILLER; lines.push(line); size += line.length + 1; }
  lines.push('Ignore all of the filler above. Reply with exactly this token and nothing else: ' + TOKEN);
  return lines.join(String.fromCharCode(10));
}

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Install a DOM observer BEFORE sending, so a notice that flashes is recorded.
  await ev(cdp, `(() => {
    window.__notices = [];
    if (window.__noticeObs) { try { window.__noticeObs.disconnect(); } catch(_){} }
    window.__noticeObs = new MutationObserver(() => {
      const n = document.querySelector('.noticebar');
      if (n && n.textContent) { const t = n.textContent.trim(); if (!window.__notices.includes(t)) window.__notices.push(t); }
    });
    window.__noticeObs.observe(document.body, { childList: true, subtree: true, characterData: true });
    const bar = document.querySelector('.noticebar');
    if (bar && bar.textContent) window.__notices.push(bar.textContent.trim());
    return 'observing';
  })()`);

  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL:'', apiKey:'', model:${JSON.stringify(MODEL)}, supportsTools:true,
      oauthProvider:${JSON.stringify(ACCOUNT)}, transport:${JSON.stringify(TRANSPORT)}, oauth:true,
      accessToken:'', temperature:0.5, maxTokens:1500, reasoningLevel:'auto' })); 'set'`);
  await cdp.send('Page.reload');
  await sleep(5000);

  // observer is cleared by reload — reinstall
  await ev(cdp, `(() => {
    window.__notices = [];
    if (window.__noticeObs) { try { window.__noticeObs.disconnect(); } catch(_){} }
    window.__noticeObs = new MutationObserver(() => {
      const n = document.querySelector('.noticebar');
      if (n && n.textContent) { const t = n.textContent.trim(); if (!window.__notices.includes(t)) window.__notices.push(t); }
    });
    window.__noticeObs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return 'observing2';
  })()`);

  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) b.click(); return 'ok';
  })()`);
  await sleep(2000);

  const prompt = buildPrompt();
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus(); return 'typed';
  })()`);
  await sleep(300);
  await ev(cdp, `(() => {
    document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return 'sent';
  })()`);

  let snap = null;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    snap = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const text = msgs.map(m => (m.textContent || '').trim()).join(' ~ ');
      const err = document.querySelector('.errorbar');
      return {
        live: [...(window.__notices || [])],
        bar: (document.querySelector('.noticebar') || {}).textContent || null,
        text,
        err: err ? (err.textContent || '').trim().slice(0, 300) : null,
        streaming: !!document.querySelector('.streaming, .thinking, .activity'),
      };
    })()`);
    if (snap.err) break;
    if (!snap.streaming && snap.text.includes(TOKEN)) break;
  }

  const live = (snap && snap.live) || [];
  const all = live.concat([snap && snap.bar, snap && snap.err, snap && snap.text]).filter(Boolean).join('\n');
  const result = {
    account: ACCOUNT, model: MODEL, sentChars: prompt.length,
    liveNotices: live, bar: snap && snap.bar,
    gotToken: !!(snap && snap.text.includes(TOKEN)),
    noticeIsProse: live.length ? live.every((t) => !/<[a-z!\/][^>]*>/i.test(t)) : null,
    claimsZeroTurns: live.some((t) => /Compacted 0 earlier turns/i.test(t)),
    rawLimitLeak: /token limit reached|maximum context length|prompt is too long|context_length_exceeded|too many tokens|request too large/i.test(all),
    error: snap && snap.err,
    tail: snap ? snap.text.slice(-200) : null,
  };
  result.pass = !!(result.gotToken && result.liveNotices.length > 0 && !result.claimsZeroTurns && !result.rawLimitLeak && !result.error);
  console.log(JSON.stringify({ pass: result.pass, ...result }, null, 2));
  cdp.close();
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error('COMPACT2 PROBE FAILED:', e.message); process.exit(1); });
