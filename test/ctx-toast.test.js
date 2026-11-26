// The context-pressure toast must speak at the right pressure and must never let
// one dismissal suppress a *different* warning (or a later, worse turn).
//
//   node test/ctx-toast.test.js
'use strict';

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else fails.push(name + (detail === undefined ? '' : '  — ' + detail));
};
const eq = (name, got, want) => ok(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

(async () => {
  const { TOAST_WARM, TOAST_HOT, ctxPercent, ctxTone, ctxToastState } = await import('../src/ctx-toast.mjs');

  // --- thresholds -----------------------------------------------------------
  eq('TOAST_WARM is 70 %', TOAST_WARM, 70);
  eq('TOAST_HOT is 90 %', TOAST_HOT, 90);
  eq('0 % is cool', ctxTone(0), 'cool');
  eq('69 % is cool', ctxTone(69), 'cool');
  eq('70 % is warm (inclusive)', ctxTone(70), 'warm');
  eq('89 % is warm', ctxTone(89), 'warm');
  eq('90 % is hot (inclusive)', ctxTone(90), 'hot');
  eq('100 % is hot', ctxTone(100), 'hot');
  eq('NaN is cool (never a toast on unknown state)', ctxTone(NaN), 'cool');

  // --- window arithmetic ----------------------------------------------------
  eq('half of 200k', ctxPercent(100000, 200000), 50);
  eq('a window of 0 cannot divide', ctxPercent(1234, 0), 0);
  eq('no usage', ctxPercent(0, 200000), 0);
  eq('missing everything', ctxPercent(undefined, undefined), 0);
  // 1M-window models: 700k is 70 %
  eq('700k of 1M', ctxPercent(700000, 1048576), 67);
  eq('its tone', ctxTone(ctxPercent(700000, 1048576)), 'cool');

  // --- the component's own state machine ------------------------------------
  const W = 200000;
  const at1 = 1_700_000_000_000;
  const at2 = at1 + 60_000;

  // No pressure: silent.
  let s = ctxToastState({ used: 100000, win: W, closedTone: null, closedAt: 0, seenAt: at1 });
  eq('50 % → cool', s.tone, 'cool');
  eq('50 % → not visible', s.visible, false);
  eq('50 % → displays 50', s.pct, 50);

  // First warning.
  s = ctxToastState({ used: 150000, win: W, closedTone: null, closedAt: 0, seenAt: at1 });
  eq('75 % → warm', s.tone, 'warm');
  eq('75 % → visible', s.visible, true);
  eq('75 % → displays 75', s.pct, 75);

  // User dismisses it on this turn.
  s = ctxToastState({ used: 150000, win: W, closedTone: 'warm', closedAt: at1, seenAt: at1 });
  eq('dismissed 75 % → hidden', s.visible, false);

  // The same turn grows past 90 % (e.g. a tool round-trip): the escalation is a
  // different tone, so the user still hears it.
  s = ctxToastState({ used: 185000, win: W, closedTone: 'warm', closedAt: at1, seenAt: at1 });
  eq('after dismissing warm, 92 % still speaks', s.visible, true);
  eq('after dismissing warm, 92 % is hot', s.tone, 'hot');

  // Dismiss the hot one too: silent for the rest of that turn.
  s = ctxToastState({ used: 185000, win: W, closedTone: 'hot', closedAt: at1, seenAt: at1 });
  eq('dismissed hot → hidden', s.visible, false);

  // A later turn while still under pressure revives it.
  s = ctxToastState({ used: 185000, win: W, closedTone: 'hot', closedAt: at1, seenAt: at2 });
  eq('a new turn revives the warning', s.visible, true);

  // A later turn that is genuinely fine stays silent.
  s = ctxToastState({ used: 20000, win: W, closedTone: 'hot', closedAt: at1, seenAt: at2 });
  eq('a compacted turn goes quiet', s.visible, false);

  // Usage with no timestamp: dismissals are allowed to stick (nothing newer to
  // compare against), but the very first render still speaks.
  s = ctxToastState({ used: 195000, win: W, closedTone: null, closedAt: 0, seenAt: 0 });
  eq('97 % without a timestamp still warns', s.visible, true);
  s = ctxToastState({ used: 195000, win: W, closedTone: 'hot', closedAt: 0, seenAt: 0 });
  eq('and its dismissal holds while no turn follows', s.visible, false);

  // An unknown window must never produce a toast (the old bug shape: divide by
  // zero → Infinity → "hot" forever).
  s = ctxToastState({ used: 500000, win: 0, closedTone: null, closedAt: 0, seenAt: at1 });
  eq('unknown window → cool', s.tone, 'cool');
  eq('unknown window → silent', s.visible, false);
  s = ctxToastState({});
  eq('empty state → silent', s.visible, false);

  // Rounding must not let the number and the wording disagree.
  s = ctxToastState({ used: 179000, win: W, closedTone: null, closedAt: 0, seenAt: at1 });
  eq('89.5 % displays 90', s.pct, 90);
  eq('89.5 % is therefore hot, not a "90 %" warm toast', s.tone, 'hot');

  // --- verdict --------------------------------------------------------------
  const total = pass + fails.length;
  if (fails.length) {
    console.log('FAILED');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log(`\n${pass}/${total} passed`);
    process.exit(1);
  }
  console.log(`OK  ${pass}/${total} assertions`);
})().catch((e) => {
  console.error('ctx-toast test crashed:', (e && e.stack) || e);
  process.exit(2);
});
