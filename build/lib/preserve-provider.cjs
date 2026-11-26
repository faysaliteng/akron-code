// Probes point the composer at their own provider for one run. That provider is
// the user's real state, not test furniture, so any probe that rewrites it has
// to snapshot both halves — renderer localStorage and main settings — and put
// them back on every exit path (success, failure, throw).
//
// Usage:
//   const preserve = require('./lib/preserve-provider')(ev, cdp, { keys: ['autobot:activeId'] });
//   await preserve.snapshot();          // before the probe writes anything
//   ...
//   await preserve.restore();           // before cdp.close()/process.exit()
//   // and inside .catch(): if (preserve) await preserve.restore();
//
// `keys` adds localStorage keys beyond `autobot:provider` (e.g. activeId) to the
// same snapshot. `restore()` is idempotent and reloads the page once.
module.exports = function preserveProvider(ev, cdp, opts) {
  const extraKeys = (opts && opts.keys) || [];
  const KEYS = ['autobot:provider', ...extraKeys];
  let ls = null;
  let main = null;
  let armed = false;

  return {
    async snapshot() {
      ls = await ev(cdp, `(() => {
        const keys = ${JSON.stringify(KEYS)};
        const out = {};
        for (const k of keys) out[k] = localStorage.getItem(k);
        return out;
      })()`);
      main = await ev(cdp, `window.autobot.getSettings().then(s => (s && s.provider) || null)`);
      armed = true;
      return { keys: Object.keys(ls || {}), hadMain: !!main };
    },

    async restore() {
      if (!armed) return;
      armed = false;
      if (!ls && !main) return;
      try {
        if (ls) {
          await ev(cdp, `(() => {
            const prev = ${JSON.stringify(ls)};
            for (const k of Object.keys(prev)) {
              if (prev[k] === null) localStorage.removeItem(k);
              else localStorage.setItem(k, prev[k]);
            }
            return 'ls-restored';
          })()`);
        }
        if (main) {
          await ev(cdp, `window.autobot.setSettings({ provider: ${JSON.stringify(main)} }).then(() => 'main-restored')`);
        }
        await cdp.send('Page.reload');
        await new Promise((r) => setTimeout(r, 4000));
        const base = (main && main.baseURL) || '(oauth account)';
        const model = (main && main.model) || '';
        console.log('composer provider restored: ' + base + ' / ' + model);
      } catch (e) {
        console.error('provider restore failed: ' + (e && e.message ? e.message : e));
      }
    },
  };
};
