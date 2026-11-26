// Verify the model picker renders live per-account model catalogs with
// context-window labels, and that the composer shows the window chip.
//
// Every selector is scoped to `.model-menu`: Settings → Accounts renders the
// same `.prov-group` / `.prov-acct` classes, so an unscoped query picks up rows
// that have no models and makes this probe look broken.
//
// Usage: node build/probe-picker.cjs [port]
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target on :' + port);
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

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};

// JS injected into the page: every query starts from the open model menu.
const MENU = `(() => document.querySelector('.model-menu'))()`;
const GROUP = (name) => `(() => {
  const menu = document.querySelector('.model-menu');
  if (!menu) return null;
  return [...menu.querySelectorAll('.prov-group')].find((x) => ${name}.test(((x.querySelector('.prov-name') || {}).textContent || '').trim())) || null;
})()`;

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  };

  // Normalise: a menu left open by an earlier probe must be closed first, so
  // "did clicking the pill open it" measures one real transition.
  await ev(`(() => {
    if (document.querySelector('.model-menu')) {
      const pill = document.querySelector('.model-pill');
      if (pill) pill.click();
    }
    return !document.querySelector('.model-menu');
  })()`);
  await sleep(400);

  const pillClicked = await ev(`(() => { const pill = document.querySelector('.model-pill'); if (pill) pill.click(); return !!pill; })()`);
  ok('composer model pill present', !!pillClicked);

  // providerStatus + providerModels round trips; poll until every account row
  // that is showing has either models or an explicit "none" line.
  let snap = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    snap = await ev(`(() => {
      const menu = document.querySelector('.model-menu');
      if (!menu) return { menuOpen: false, groups: [] };
      const groups = [...menu.querySelectorAll('.prov-group')].map(g => {
        const name = (g.querySelector('.prov-name') || {}).textContent || '';
        const unv = !!g.querySelector('.prov-unv');
        const authBtns = [...g.querySelectorAll('.prov-link')].map(b => (b.textContent || '').trim());
        const accts = [...g.querySelectorAll('.prov-acct')].map(a => ({
          name: ((a.querySelector('.prov-pick .model-opt-name') || {}).textContent) || '',
          on: a.classList.contains('on'),
          models: [...a.querySelectorAll('.prov-model')].map(m => ({
            label: ((m.querySelector('.model-opt-name') || {}).textContent) || '',
            win: ((m.querySelector('.model-opt-prov') || {}).textContent) || '',
            on: m.classList.contains('on'),
            title: m.getAttribute('title') || '',
          })),
          none: ((a.querySelector('.prov-none') || {}).textContent) || '',
        }));
        return { name: name.trim(), unv, authBtns, accts };
      });
      const pill = document.querySelector('.model-pill');
      const chip = document.querySelector('.model-pill .model-win');
      return {
        menuOpen: true,
        pill: pill ? (pill.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        chip: chip ? (chip.textContent || '').trim() : null,
        groups,
      };
    })()`);
    const withAcct = (snap && snap.groups || []).filter(g => g.accts.length > 0);
    const merged = withAcct.length > 0 && withAcct.every(g =>
      g.accts.every(a => a.models.length > 0 || a.none),
    );
    if (merged) break;
  }

  ok('the model menu opened', !!(snap && snap.menuOpen));
  const groups = (snap && snap.groups) || [];
  ok('subscription providers are listed inside the menu', groups.length > 0, groups.map(g => g.name));
  ok('no settings-section rows leaked into the menu', await ev(`document.querySelectorAll('.model-menu .acct-prov').length === 0`));

  // ---- Claude: one auth button, CLI-owned flow only ------------------------
  const claude = groups.find(g => /^claude$/i.test(g.name));
  if (claude) {
    ok('claude has an account row', claude.accts.length > 0, claude.accts.map(a => a.name));
    ok('claude offers exactly one auth button', claude.authBtns.length === 1, claude.authBtns);
    ok('claude never offers the independent "Paste code" path', !(await ev(`!!document.querySelector('.model-menu .prov-link-sub')`)));
    ok('claude auth button reads Reconnect or Sign in', claude.authBtns.every(t => /^(reconnect|sign in)$/i.test(t)), claude.authBtns);

    // Models only render under the account the conversation is using, so select
    // the Claude account and read what the menu actually prints for it.
    await ev(`(() => {
      const menu = document.querySelector('.model-menu');
      if (!menu) return false;
      const g = [...menu.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
      if (!g) return false;
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    let cmodels = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      cmodels = await ev(`(() => {
        const menu = document.querySelector('.model-menu');
        if (!menu) return [];
        const g = [...menu.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
        if (!g) return [];
        return [...g.querySelectorAll('.prov-acct.on .prov-model, .prov-acct.on .prov-none')].map(m => ({
          label: ((m.querySelector('.model-opt-name') || {}).textContent || m.textContent || '').trim(),
          win: ((m.querySelector('.model-opt-prov') || {}).textContent || '').trim(),
        }));
      })()`);
      if (cmodels && cmodels.length >= 10) break;
    }
    ok('claude account exposes its live model catalog', cmodels.length >= 10, cmodels.length);
    if (cmodels.length) {
      ok('claude models carry a context-window label', cmodels.every(m => /^[0-9.]+[KM]$/.test(m.win)), cmodels.filter(m => !/^[0-9.]+[KM]$/.test(m.win)).map(m => m.label + ':' + m.win));
      ok('claude lists at least one 1M-window model', cmodels.some(m => m.win === '1M'), cmodels.map(m => m.label + '=' + m.win).slice(0, 6));
      ok('claude lists at least one 200K model', cmodels.some(m => m.win === '200K'), cmodels.map(m => m.label + '=' + m.win).slice(0, 6));
      ok('claude window labels never say 0K', !cmodels.some(m => m.win === '0K'), cmodels.map(m => m.label + '=' + m.win).slice(0, 6));
    }
  } else {
    ok('claude provider group present in the menu', false, groups.map(g => g.name));
  }

  // ---- ChatGPT: shipped list is the live entitlement ----------------------
  const liveChat = await ev(`window.autobot.providerModels('chatgpt').then(r => r && r.ok && r.models ? r.models.map(m => m.id) : null).catch(() => null)`);
  const gpt = groups.find(g => /chatgpt/i.test(g.name));
  if (gpt && gpt.accts.length) {
    ok('chatgpt has an account row', true, gpt.accts.map(a => a.name));
    await ev(`(() => {
      const menu = document.querySelector('.model-menu');
      if (!menu) return false;
      const g = [...menu.querySelectorAll('.prov-group')].find(x => /chatgpt/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
      if (!g) return false;
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    let gm = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      gm = await ev(`(() => {
        const menu = document.querySelector('.model-menu');
        if (!menu) return [];
        const g = [...menu.querySelectorAll('.prov-group')].find(x => /chatgpt/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
        if (!g) return [];
        return [...g.querySelectorAll('.prov-acct.on .prov-model')].map(m => ({
          label: ((m.querySelector('.model-opt-name') || {}).textContent || '').trim(),
          win: ((m.querySelector('.model-opt-prov') || {}).textContent || '').trim(),
        }));
      })()`);
      if (gm && gm.length >= 5) break;
    }
    ok('chatgpt account exposes its live catalog', gm.length >= 5, gm.length);
    ok('chatgpt menu matches the live entitlement count', !liveChat || gm.length === liveChat.length, { menu: gm.length, live: liveChat && liveChat.length });
    ok('chatgpt models carry a context-window label', gm.length > 0 && gm.every(m => /^[0-9.]+[KM]$/.test(m.win)), gm.filter(m => !/^[0-9.]+[KM]$/.test(m.win)).map(m => m.label + ':' + m.win));
    ok('chatgpt menu does not offer a retired/foreign model', !gm.some(m => /gpt-5\.1-codex-max|gpt-4o/i.test(m.label)), gm.map(m => m.label));
    // The model committed to provider state must be one the live grant lists.
    const picked = await ev(`(() => {
      const p = document.querySelector('.model-pill .model-pill-name, .model-pill');
      return p ? (p.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    })()`);
    ok('composer shows the chatgpt selection', !liveChat || liveChat.length === 0 || !!picked, picked);
  } else {
    console.log('  note: no chatgpt account on this machine');
  }

  // ---- Antigravity --------------------------------------------------------
  const ag = groups.find(g => /antigravity/i.test(g.name));
  if (ag) {
    ok('antigravity has an account row', ag.accts.length > 0, ag.accts.map(a => a.name));
    // Models only render under the account the conversation is using, so pick
    // the Antigravity account and read what the menu actually prints.
    await ev(`(() => {
      const menu = document.querySelector('.model-menu');
      if (!menu) return false;
      const g = [...menu.querySelectorAll('.prov-group')].find(x => /antigravity/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
      if (!g) return false;
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    let rows = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      rows = await ev(`(() => {
        const menu = document.querySelector('.model-menu');
        if (!menu) return [];
        const g = [...menu.querySelectorAll('.prov-group')].find(x => /antigravity/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
        if (!g) return [];
        return [...g.querySelectorAll('.prov-acct.on .prov-model')].map(m => ({
          label: ((m.querySelector('.model-opt-name') || {}).textContent) || '',
          win: ((m.querySelector('.model-opt-prov') || {}).textContent) || '',
        }));
      })()`);
      if (rows && rows.length >= 20) break;
    }
    ok('antigravity account exposes its live catalog', rows.length >= 20, rows.length);
    const bad = (rows || []).filter(m => !/^[0-9.]+[KM]$/.test(m.win));
    ok('antigravity models are window-labelled', (rows || []).length > 0 && bad.length === 0, bad.map(m => m.label + ':' + m.win));
    ok('antigravity catalog is not the 4-model static fallback', rows.length !== 4, rows.length);
  } else {
    console.log('  note: no antigravity account on this machine');
  }

  // ---- Hand the conversation back to Claude ------------------------------
  await ev(`(() => {
    const menu = document.querySelector('.model-menu');
    if (!menu) return false;
    const g = [...menu.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
    if (!g) return false;
    const b = g.querySelector('.prov-acct .prov-pick');
    if (b) b.click();
    return true;
  })()`);
  await sleep(600);

  const windows = await ev(`(() => {
    try { return JSON.parse(localStorage.getItem('autobot:modelWindows') || '{}'); } catch (e) { return null; }
  })()`);
  ok('the window cache was written for /context', !!(windows && Object.keys(windows).length >= 5), windows && Object.keys(windows).length);
  ok('the cache holds only positive windows', !!(windows && Object.values(windows).every(w => w > 0)));

  // Leave the menu closed so the next probe starts from a known state.
  await ev(`(() => { const m = document.querySelector('.model-menu'); if (m) { const p = document.querySelector('.model-pill'); if (p) p.click(); } return !document.querySelector('.model-menu'); })()`);

  console.log('\nRESULT: ' + pass + ' checks passed');
  cdp.close();
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('PICKER PROBE FAILED:', e.message); process.exit(1); });
