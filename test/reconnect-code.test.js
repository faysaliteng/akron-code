'use strict';
// The Claude reconnect paste box forwards what the user pastes to the Claude
// Code CLI's login exchange. Ground truth observed from `claude auth login` on
// this machine:
//
//   abc123         -> "That doesn't look like the full code. Copy all of it,
//                     including the # in the middle." and the CLI KEEPS WAITING
//   abc123#def456  -> a real token exchange, then its own verdict
//
// A bare code forwarded to the CLI produces no result event, which is exactly
// the "sign-in does nothing" bug. So the normalisation must refuse it locally,
// and must rescue the other shapes a user can realistically paste.

const { normalizeReconnectCode, isRetryableLine } = require('../electron/reconnect-code');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; process.exitCode = 1; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

console.log('\nnormalizeReconnectCode');

// A bare code is the bug: reject it here so the box stays open.
const bare = normalizeReconnectCode('abc123');
ok('bare code is refused', bare.ok === false);
ok('refusal names the # requirement', /#/.test(bare.error || '') && /code#state|full code/i.test(bare.error || ''));
eq('refusal wording is stable', bare.error, 'the page shows code#state — copy all of it, including the # in the middle');

// The format the manual callback page prints.
eq('code#state passes through', normalizeReconnectCode('abc123#def456'), { ok: true, value: 'abc123#def456' });
eq('surrounding whitespace is trimmed', normalizeReconnectCode('  abc#def  '), { ok: true, value: 'abc#def' });
ok('the # may appear more than once', normalizeReconnectCode('a#b#c').ok === true);

// What the address bar holds when the browser could not reach `localhost`.
eq('callback URL becomes code#state', normalizeReconnectCode('https://localhost:59107/callback?code=AAA&state=BBB'), { ok: true, value: 'AAA#BBB' });
eq('http scheme accepted', normalizeReconnectCode('http://127.0.0.1:1/callback?state=S&code=C'), { ok: true, value: 'C#S' });
eq('code-only callback URL drops no state', normalizeReconnectCode('https://localhost/cb?code=ONLY'), { ok: true, value: 'ONLY' });
eq('URL percent-decoding applies', normalizeReconnectCode('https://localhost/cb?code=a%2Bb&state=s%2Ft'), { ok: true, value: 'a+b#s/t' });

// A URL with no code never came from a callback — let the CLI judge it rather
// than inventing a refusal it did not ask for.
eq('code-less URL is forwarded verbatim', normalizeReconnectCode('https://x/y?state=BBB'), { ok: true, value: 'https://x/y?state=BBB' });

// Empty / absent input.
ok('empty string refused', normalizeReconnectCode('').ok === false);
ok('undefined refused', normalizeReconnectCode(undefined).ok === false);
ok('null refused', normalizeReconnectCode(null).ok === false);
ok('whitespace-only refused', normalizeReconnectCode('   ').ok === false);

console.log('\nisRetryableLine');

// The CLI's "I am still waiting" language. While these arrive the box must
// re-enable so the user keeps their attempt.
ok('full-code prompt is retryable', isRetryableLine("That doesn't look like the full code. Copy all of it, including the # in the middle."));
ok('short "# in the middle" line is retryable', isRetryableLine('copy all of it, including the # in the middle'));
ok('case-insensitive', isRetryableLine('COPY ALL OF IT'));
ok('empty is not retryable', !isRetryableLine(''));
ok('undefined is not retryable', !isRetryableLine(undefined));

// The CLI's terminal verdicts. These end the flow; the box must close and the
// line must be shown as the reason, never as a generic "cancelled".
ok('rejected-code verdict is not retryable', !isRetryableLine("Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt."));
ok('expired verdict is not retryable', !isRetryableLine('That code has expired'));
ok('url line is not retryable', !isRetryableLine('Opening browser to sign in…'));

// Round trip: whatever the normaliser emits must survive a second pass.
const once = normalizeReconnectCode('https://localhost:5/cb?code=K&state=S');
const twice = normalizeReconnectCode(once.value);
eq('normalisation is idempotent', once, twice);

console.log('\n' + (fail ? '✗ ' + fail + ' failed, ' + pass + ' passed' : '=== RESULT: ' + pass + ' passed, 0 failed ==='));
