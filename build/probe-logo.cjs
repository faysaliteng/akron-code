// Prove the brand mark animates while a turn is running and rests when idle.
// Usage: node build/probe-logo.cjs [port] [model]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'auto';
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

// Snapshot of the titlebar mark: class, animation names, live transform.
const SAMPLE = `(() => {
  const mark = document.querySelector('.titlebar svg.logo');
  const act  = document.querySelector('.activity svg.logo, .run-activity svg.logo');
  const read = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rays = el.querySelector('.logo-rays');
    const core = el.querySelector('.logo-core');
    const rs = rays ? getComputedStyle(rays) : null;
    return {
      cls: el.getAttribute('class'),
      anim: cs.animationName,
      transform: cs.transform,
      rayAnim: rs ? rs.animationName : null,
      rayDur: rs ? rs.animationDuration : null,
      rayTransform: rs ? rs.transform : null,
      coreAnim: core ? getComputedStyle(core).animationName : null,
      // a running animation has a non-none transform that changes between samples
      duration: rs ? rs.animationDuration : null,
    };
  };
  return {
    titlebar: read(mark),
    activity: read(act),
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    streaming: !!document.querySelector('.msg.assistant .cursor, .stop-btn, .sending'),
  };
})()`;

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      name: 'FreeLLMAPI', baseURL: 'http://localhost:3001/v1', model: ${JSON.stringify(MODEL)},
      apiKey: '', temperature: 0.7, maxTokens: 2000, reasoningLevel: 'auto', supportsTools: true
    })); localStorage.setItem('autobot:activeId', null); 'set'`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(3500);

  // open a conversation (dev app leaves activeId null after reload)
  await ev(cdp, `(() => {
    const row = document.querySelector('.conv');
    if (row) { row.click(); return 'conv'; }
    const btn = [...document.querySelectorAll('button')].find(b => /new chat|new/i.test(b.textContent || ''));
    if (btn) { btn.click(); return 'new'; }
    return 'none';
  })()`);
  await sleep(1800);

  const idleA = await ev(cdp, SAMPLE);
  await sleep(700);
  const idleB = await ev(cdp, SAMPLE);

  // send a prompt long enough to stream for several seconds
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Write a numbered list of 30 short shell commands, one per line, no commentary.');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return 'typed';
  })()`);
  await sleep(250);
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return 'sent';
  })()`);

  // sample fast while the turn runs
  const seen = [];
  let liveSamples = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    const s = await ev(cdp, SAMPLE);
    if (s.titlebar && /logo-live/.test(s.titlebar.cls || '')) {
      liveSamples += 1;
      seen.push({
        t: i * 150,
        cls: s.titlebar.cls,
        rayAnim: s.titlebar.rayAnim,
        rayTransform: s.titlebar.rayTransform,
        coreAnim: s.titlebar.coreAnim,
      });
    }
    const reply = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      return { text: el ? (el.textContent || '').trim().length : 0, error: err ? err.textContent.trim().slice(0,160) : null };
    })()`);
    if (reply.text > 40 && !s.streaming) break;
    if (reply.error) break;
  }

  await sleep(1200);
  const rest = await ev(cdp, SAMPLE);

  // Did the mark actually move? Compare first/last ray transform while streaming.
  const moved = seen.length > 1 && seen[0].rayTransform !== seen[seen.length - 1].rayTransform;
  const out = {
    reducedMotion: idleA.reduced,
    idle: { cls: idleA.titlebar && idleA.titlebar.cls, anim: idleA.titlebar && idleA.titlebar.anim },
    idleStable: idleA.titlebar && idleB.titlebar ? idleA.titlebar.transform === idleB.titlebar.transform : null,
    streamingSamples: liveSamples,
    streamingAnim: seen[0] && seen[0].rayAnim,
    streamingDuration: seen[0] && seen[0].rayDur,
    coreAnim: seen[0] && seen[0].coreAnim,
    transformMoved: moved,
    rest: { cls: rest.titlebar && rest.titlebar.cls, anim: rest.titlebar && rest.titlebar.anim },
  };
  const pass = liveSamples > 0 && moved && /none/.test(out.idle.anim || 'none');
  console.log(JSON.stringify({ pass, ...out }, null, 2));
  cdp.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('LOGO PROBE FAILED:', e.message); process.exit(1); });
