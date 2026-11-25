// Verify the model picker renders live per-account model catalogs with
// context-window labels, and that the composer shows the window chip.
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

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
    return r.result.value;
  };

  // Open the menu (idempotent: only click if it is not already open).
  await ev(`(() => {
    const open = document.querySelector('.model-menu');
    const pill = document.querySelector('.model-pill');
    if (!open && pill) pill.click();
    return !!pill;
  })()`);

  // providerStatus + providerModels round trips; poll until stable.
  let snap = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    snap = await ev(`(() => {
      const groups = [...document.querySelectorAll('.prov-group')].map(g => {
        const name = (g.querySelector('.prov-name') || {}).textContent || '';
        const unv = !!g.querySelector('.prov-unv');
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
        return { name, unv, accts };
      });
      const pill = document.querySelector('.model-pill');
      const chip = document.querySelector('.model-pill .model-win');
      const menuOpen = !!document.querySelector('.model-menu');
      return {
        menuOpen,
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

  console.log(JSON.stringify(snap, null, 2).slice(0, 6000));

  ok('the model menu opened', !!(snap && snap.menuOpen));
  const groups = (snap && snap.groups) || [];
  ok('subscription providers are listed', groups.length > 0, groups.map(g => g.name));

  const claude = groups.find(g => /claude/i.test(g.name));
  if (claude) {
    ok('claude has an account row', claude.accts.length > 0, claude.accts.map(a => a.name));
    // Models only render under the account the conversation is using, so select
    // the Claude account and read what the menu actually prints for it.
    await ev(`(() => {
      const g = [...document.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
      if (!g) return false;
      const open = document.querySelector('.model-menu');
      if (!open) { const pill = document.querySelector('.model-pill'); if (pill) pill.click(); }
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    let cmodels = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      cmodels = await ev(`(() => {
        const g = [...document.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
        if (!g) return [];
        return [...g.querySelectorAll('.prov-acct.on .prov-model, .prov-acct.on .prov-none')].map(m => ({
          label: ((m.querySelector('.model-opt-name') || {}).textContent || m.textContent || '').trim(),
          win: ((m.querySelector('.model-opt-prov') || {}).textContent || '').trim(),
        }));
      })()`);
      if (cmodels && cmodels.length >= 10) break;
    }
    if (cmodels.length) {
      const models = cmodels;
      ok('claude account exposes its live model catalog', models.length >= 10, models.length);
      ok('claude models carry a context-window label', models.every(m => /^[0-9.]+[KM]$/.test(m.win)), models.filter(m => !/^[0-9.]+[KM]$/.test(m.win)).map(m => m.label + ':' + m.win));
      ok('claude lists at least one 1M-window model', models.some(m => m.win === '1M'), models.map(m => m.label + '=' + m.win));
      ok('claude lists at least one 200K model', models.some(m => m.win === '200K'), models.map(m => m.label + '=' + m.win));
      ok('claude window labels never say 0K', !models.some(m => m.win === '0K'), models.map(m => m.label + '=' + m.win));
    } else {
      ok('claude account exposes its live model catalog', false, cmodels);
    }
  } else {
    ok('claude provider group present', false, groups.map(g => g.name));
  }

  const ag = groups.find(g => /antigravity/i.test(g.name));
  if (ag) {
    ok('antigravity has an account row', ag.accts.length > 0, ag.accts.map(a => a.name));
    // Models only render under the account the conversation is using, so pick
    // the Antigravity account and read what the menu actually prints.
    await ev(`(() => {
      const g = [...document.querySelectorAll('.prov-group')].find(x => /antigravity/i.test((x.querySelector('.prov-name') || {}).textContent || ''));
      if (!g) return false;
      const a = g.querySelector('.prov-acct');
      if (!a) return false;
      const open = document.querySelector('.model-menu');
      if (!open) { const pill = document.querySelector('.model-pill'); if (pill) pill.click(); }
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    let rows = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      rows = await ev(`(() => {
        const g = [...document.querySelectorAll('.prov-group')].find(x => /antigravity/i.test((x.querySelector('.prov-name') || {}).textContent || ''));
        if (!g) return [];
        return [...g.querySelectorAll('.prov-acct.on .prov-model')].map(m => ({
          label: ((m.querySelector('.model-opt-name') || {}).textContent) || '',
          win: ((m.querySelector('.model-opt-prov') || {}).textContent) || '',
        }));
      })()`);
      if (rows && rows.length >= 20) break;
    }
    ok('antigravity account exposes its live catalog', !!(rows && rows.length >= 20), rows && rows.length);
    const bad = (rows || []).filter(m => !/^[0-9.]+[KM]$/.test(m.win));
    ok('antigravity models are window-labelled', (rows || []).length > 0 && bad.length === 0, bad.map(m => m.label + ':' + m.win));
    ok('antigravity catalog is not the 4-model static fallback', (rows || []).length !== 4, rows && rows.length);
    // Hand the conversation back to Claude so the menu is left as we found it.
    await ev(`(() => {
      const g = [...document.querySelectorAll('.prov-group')].find(x => /^claude$/i.test(((x.querySelector('.prov-name') || {}).textContent || '').trim()));
      if (!g) return false;
      const open = document.querySelector('.model-menu');
      if (!open) { const pill = document.querySelector('.model-pill'); if (pill) pill.click(); }
      const b = g.querySelector('.prov-acct .prov-pick');
      if (b) b.click();
      return true;
    })()`);
    await sleep(500);
  } else {
    console.log('  note: no antigravity account on this machine');
  }

  const windows = await ev(`(() => {
    try { return JSON.parse(localStorage.getItem('autobot:modelWindows') || '{}'); } catch (e) { return null; }
  })()`);
  ok('the window cache was written for /context', !!(windows && Object.keys(windows).length >= 5), windows && Object.keys(windows).length);
  ok('the cache holds only positive windows', !!(windows && Object.values(windows).every(w => w > 0)));

  console.log('\\nRESULT: ' + pass + ' checks passed');
  cdp.close();
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('PICKER PROBE FAILED:', e.message); process.exit(1); });
