'use strict';
// A persisted orchestrator pool holds no bearer token — `oauthProvider` and
// `model` only. Handing it to runAgent unchanged put
//
//   Authorization: Bearer
//
// on the wire (accessToken '' -> apiKey '' -> empty) and Anthropic answered 401
// `authentication_error: Invalid bearer token`, which the app surfaced as
// "Claude needs to be signed in again" for an account whose token was provably
// good. Every row must be resolved before the turn, and one unresolvable row
// must cost only its row.

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   - ' + name); }
  else { fail++; process.exitCode = 1; console.log('  FAIL - ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const { hydrateOrchestrator, poolDeadNotice, isOrchestratorActiveForTurn, createPoolNoticeDeduper } = require('../electron/orch-hydrate');

// A resolver stand-in: stamps the token a real hydrateProvider() would mint,
// removes accessToken on demand, and records which rows it was handed.
function fakeHydrate(deadNames = []) {
  const seen = [];
  const impl = async (p) => {
    seen.push(p.model);
    if (deadNames.includes(p.model)) {
      const e = new Error('needs sign-in');
      e.code = 'provider_needs_signin';
      throw e;
    }
    return Object.assign({}, p, { accessToken: 'sk-ant-oat01-' + p.model, source: 'resolved' });
  };
  impl.seen = seen;
  return impl;
}

const row = (model, extra) => Object.assign({
  id: 'oauth|claude:a|' + model,
  name: 'Provider ' + model,
  oauthProvider: 'claude:a',
  oauth: true,
  transport: 'anthropic',
  model,
}, extra || {});

(async () => {
  console.log('\norchestrator pool hydration');

  // ---- Nothing to do ------------------------------------------------------
  {
    const h = fakeHydrate();
    for (const input of [null, undefined, {}, { providers: [] }]) {
      const r = await hydrateOrchestrator(input, h);
      ok('an empty pool passes through: ' + JSON.stringify(input), r.orch === (input || null) && r.dead.length === 0);
    }
    eq('and no row was resolved', h.seen, []);
    let threw = null;
    try { await hydrateOrchestrator({ providers: [row('m')] }, null); } catch (e) { threw = e; }
    ok('a missing resolver is a programming error, not a silent pass', threw instanceof TypeError);
  }

  // ---- The live failure: two rows, both resolved ---------------------------
  {
    const pool = { enabled: true, activeIndex: 0, providers: [row('claude-sonnet-4-6'), row('claude-opus-4-5')] };
    const h = fakeHydrate();
    const r = await hydrateOrchestrator(pool, h);
    eq('both rows resolved in place', h.seen, ['claude-sonnet-4-6', 'claude-opus-4-5']);
    eq('order is preserved', r.orch.providers.map((p) => p.model), ['claude-sonnet-4-6', 'claude-opus-4-5']);
    ok('every row carries a token now', r.orch.providers.every((p) => p.accessToken.startsWith('sk-ant-oat01-')));
    ok('nothing was dropped', r.dead.length === 0);
    eq('activeIndex untouched', r.orch.activeIndex, 0);
    eq('the pool flag survives', r.orch.enabled, true);
    eq('no notice for a clean pool', poolDeadNotice(r.dead), '');
  }

  // ---- The saved pool is never mutated ------------------------------------
  {
    const pool = { enabled: true, activeIndex: 1, providers: [row('claude-sonnet-4-6'), row('claude-opus-4-5')] };
    const snapshot = JSON.stringify(pool);
    await hydrateOrchestrator(pool, fakeHydrate());
    eq('the persisted pool is left exactly as stored', JSON.stringify(pool), snapshot);
  }

  // ---- One dead row above the active row ---------------------------------
  {
    const pool = { enabled: true, activeIndex: 2, providers: [row('gemini-4-neon-high'), row('claude-sonnet-4-6'), row('claude-opus-4-5')] };
    const activeBefore = pool.providers[2];
    const r = await hydrateOrchestrator(pool, fakeHydrate(['gemini-4-neon-high']));
    eq('the dead row is gone', r.orch.providers.map((p) => p.model), ['claude-sonnet-4-6', 'claude-opus-4-5']);
    eq('one row reported dead', r.dead.length, 1);
    eq('and it is named', r.dead[0].entry.model, 'gemini-4-neon-high');
    // hydrateProvider() returns a fresh object (it stamps transport/token), so
    // identity cannot survive by design. What must survive is the *slot*: the
    // index has to follow the same row, not the same array position.
    eq('the turn keeps running on the same model it was on',
      r.orch.providers[r.orch.activeIndex].model, activeBefore.model);
    ok('and it is the resolved copy, not the bare row',
      r.orch.providers[r.orch.activeIndex].accessToken === 'sk-ant-oat01-claude-opus-4-5');
    eq('activeIndex moved with it', r.orch.activeIndex, 1);
    const line = poolDeadNotice(r.dead);
    ok('the notice names the model', line.includes('gemini-4-neon-high'), line);
    ok('the notice says the saved row is untouched', line.includes('The saved row is untouched'), line);
    ok('the notice says how to fix it', line.includes('sign in again in Settings'), line);
    ok('the notice never carries raw provider JSON', !line.includes('{') && !line.includes('('), line);
  }

  // ---- Every row dead is still a pool, not a crash ------------------------
  {
    const pool = { enabled: true, activeIndex: 1, providers: [row('a'), row('b')] };
    const r = await hydrateOrchestrator(pool, fakeHydrate(['a', 'b']));
    eq('an all-dead pool comes back empty', r.orch.providers.length, 0);
    eq('with the active index safe', r.orch.activeIndex, 0);
    eq('and both rows reported', r.dead.length, 2);
    ok('the plural notice reads correctly', poolDeadNotice(r.dead).includes('2 orchestrator models'), poolDeadNotice(r.dead));
  }

  // ---- Singular wording ---------------------------------------------------
  {
    const line = poolDeadNotice([{ entry: { model: 'x' }, error: new Error('e') }]);
    ok('one dead row is singular', line.includes('1 orchestrator model ') && !line.includes('models'), line);
    const unnamed = poolDeadNotice([{ entry: null, error: new Error('e') }]);
    ok('an anonymous dead row still reads as a sentence', unnamed.includes('a model'), unnamed);
    eq('no dead rows, no notice', poolDeadNotice([]), '');
    eq('a missing list, no notice', poolDeadNotice(null), '');
  }

  // ---- A row that needs no resolution keeps its identity ------------------
  {
    // hydrateProvider() short-circuits for a plain API-key row (no oauthProvider)
    // and returns the object it was given. Nothing upstream may depend on that,
    // but it must not be broken by the wrapper either.
    const plain = { id: 'p1', name: 'Local', baseURL: 'http://localhost:11434/v1', apiKey: 'k', model: 'llama3' };
    const pool = { enabled: true, activeIndex: 0, providers: [plain] };
    const r = await hydrateOrchestrator(pool, async (p) => p);
    ok('an untouched row is passed by reference', r.orch.providers[0] === plain);
  }

  // ---- Orchestrator activation & deduper guards ---------------------------
  {
    eq('null orch is inactive', isOrchestratorActiveForTurn(null, false), false);
    eq('disabled orch & disabled swarm pools is inactive', isOrchestratorActiveForTurn({ enabled: false, pools: { enabled: false }, providers: [row('a')] }, false), false);
    eq('disabled orch with pools enabled stays inactive when swarm is off', isOrchestratorActiveForTurn({ enabled: false, pools: { enabled: true }, providers: [row('a')] }, false), false);
    eq('disabled orch becomes active when swarm & pools are both on', isOrchestratorActiveForTurn({ enabled: false, pools: { enabled: true }, providers: [row('a')] }, true), true);
    eq('enabled orch is always active', isOrchestratorActiveForTurn({ enabled: true, providers: [row('a')] }, false), true);

    const deduper = createPoolNoticeDeduper();
    eq('empty dead notice does not emit', deduper.shouldEmitDead(''), false);
    eq('first dead notice emits once', deduper.shouldEmitDead('Left 5 orchestrator models out of this turn — a'), true);
    eq('identical consecutive dead notice is suppressed', deduper.shouldEmitDead('Left 5 orchestrator models out of this turn — a'), false);
    eq('changed dead notice emits', deduper.shouldEmitDead('Left 1 orchestrator model out of this turn — b'), true);
    eq('recovery clears dead state', deduper.shouldEmitDead(''), false);
    eq('subsequent dead notice after recovery emits again', deduper.shouldEmitDead('Left 1 orchestrator model out of this turn — b'), true);
    eq('first pruned notice emits once', deduper.shouldEmitPruned('Left 2 orchestrator models out of this turn — c'), true);
    eq('identical pruned notice is suppressed', deduper.shouldEmitPruned('Left 2 orchestrator models out of this turn — c'), false);
    deduper.reset();
    eq('reset re-enables both dead and pruned notices', deduper.shouldEmitDead('Left 1 orchestrator model out of this turn — b') && deduper.shouldEmitPruned('Left 2 orchestrator models out of this turn — c'), true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
