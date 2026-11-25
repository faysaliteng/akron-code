// A Claude subscription 429 can mean two very different things:
//   • this key is going too fast      → back off and retry (transient), or
//   • the plan's window is spent      → no amount of waiting inside the next
//                                        three minutes helps; the reset time is
//                                        known, so say it once, in prose.
// These tests pin the second case: the allowance read-out, the wording, and the
// fact that the 5-round backoff ladder is skipped when the window is empty.
//
// Run: node test/claude-allowance.test.js

'use strict';

const assert = require('assert');
const path = require('path');

const pt = require(path.join(__dirname, '..', 'electron', 'providertransport.js'));
const llm = require(path.join(__dirname, '..', 'electron', 'llm.js'));

const { claudeAllowanceHint, formatResetIn, CLAUDE_USAGE_URL } = pt._internal;
const { humanizeLLMError } = llm;

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const OAUTH = { oauth: true, accessToken: 'sk-ant-oat01-fake', transport: 'anthropic' };

function usageBody(five, seven) {
  return {
    five_hour: { utilization: five, resets_at: new Date(Date.now() + 5 * 60000).toISOString() },
    seven_day: { utilization: seven, resets_at: new Date(Date.now() + 20 * 3600000).toISOString() },
  };
}

// The real network is never touched: every case installs its own fetch.
const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

(async () => {
  console.log('Claude allowance read-out');

  t('a reset a few minutes out reads as a clock time plus minutes', () => {
    const s = formatResetIn(new Date(Date.now() + 5 * 60000).toISOString());
    assert.ok(/, in 5 min$/.test(s), s);
  });

  t('an invalid reset timestamp renders as empty, never "Invalid Date"', () => {
    assert.strictEqual(formatResetIn('not a date'), '');
    assert.strictEqual(formatResetIn(undefined), '');
  });

  await ta('a spent 5-hour window is named with its reset time', async () => {
    stubFetch(async (url) => {
      assert.strictEqual(url, CLAUDE_USAGE_URL);
      return { ok: true, json: async () => usageBody(100, 35) };
    });
    const hint = await claudeAllowanceHint(OAUTH);
    assert.ok(/Claude plan's 5-hour allowance is 100% used/.test(hint), hint);
    assert.ok(/resets .*in \d+ min/.test(hint), 'reset time missing: ' + hint);
    assert.ok(/send this request again after the reset/.test(hint), 'no recovery line: ' + hint);
    assert.ok(!/Invalid Date/.test(hint), hint);
  });

  await ta('a spent 7-day window is named when the 5-hour one is fine', async () => {
    stubFetch(async () => ({ ok: true, json: async () => usageBody(20, 100) }));
    const hint = await claudeAllowanceHint(OAUTH);
    assert.ok(/7-day allowance is 100% used/.test(hint), hint);
  });

  await ta('a non-empty but unspent window is reported without the "again" line', async () => {
    stubFetch(async () => ({ ok: true, json: async () => usageBody(62, 12) }));
    const hint = await claudeAllowanceHint(OAUTH);
    assert.ok(/5-hour allowance is 62% used/.test(hint), hint);
    assert.ok(!/send this request again/.test(hint), 'should not claim exhaustion: ' + hint);
  });

  await ta('an API key (not a subscription token) is never probed', async () => {
    let called = false;
    stubFetch(async () => { called = true; return { ok: true, json: async () => usageBody(100, 100) }; });
    const hint = await claudeAllowanceHint({ oauth: false, apiKey: 'sk-ant-api03-x' });
    assert.strictEqual(hint, '');
    assert.strictEqual(called, false, 'usage endpoint must not be called with an API key');
  });

  await ta('a failing usage endpoint yields no hint and never throws', async () => {
    stubFetch(async () => { throw new Error('network down'); });
    assert.strictEqual(await claudeAllowanceHint(OAUTH), '');
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.strictEqual(await claudeAllowanceHint(OAUTH), '');
  });

  await ta('the banner is one sentence, prose only, no vendor envelope', async () => {
    stubFetch(async () => ({ ok: true, json: async () => usageBody(100, 35) }));
    const hint = await claudeAllowanceHint(OAUTH);
    const e = new Error('LLM 429: {"type":"error","error":{"type":"rate_limit_error","message":"Error"}}');
    e.status = 429;
    e.hint = hint;
    const banner = humanizeLLMError(e);
    assert.ok(/5-hour allowance is 100% used/.test(banner), banner);
    assert.ok(!/[{}"<>]/.test(banner), 'envelope leaked into the banner: ' + banner);
    assert.ok(!/The provider is rate limiting this key — The provider is rate limiting this key/.test(banner), 'repeated head: ' + banner);
  });

  await ta('an exhausted window is not prefixed with "rate limiting this key"', async () => {
    // "retry in a moment" is the wrong instruction for a window that resets in
    // hours, so the allowance sentence stands alone.
    const e = new Error('LLM 429: x');
    e.status = 429;
    e.hint = "the Claude plan's 5-hour allowance is 100% used (resets 9:30 PM, in 4 min); send this request again after the reset — nothing in the conversation is lost";
    e.retryHopeless = true;
    const banner = humanizeLLMError(e);
    assert.ok(banner.startsWith("The Claude plan's 5-hour allowance is 100% used"), banner);
    assert.ok(!/rate limiting this key/.test(banner), 'misleading head: ' + banner);
  });

  await ta('a spent window stops the 5-round backoff ladder instead of stalling', async () => {
    delete process.env.HELIO_BACKOFF_MS;
    let messageHits = 0;
    stubFetch(async (url) => {
      if (String(url) === CLAUDE_USAGE_URL) return { ok: true, json: async () => usageBody(100, 35) };
      messageHits++;
      return {
        ok: false,
        status: 429,
        headers: { get: () => '1' },
        text: async () => '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}',
      };
    });
    const t0 = Date.now();
    let threw = null;
    try {
      await llm.chatWithFailover({
        list: [OAUTH],
        getIndex: () => 0,
        setIndex: () => {},
        messages: [{ role: 'user', content: 'hi' }],
        emit: () => {},
        maxTokens: 16,
      });
    } catch (e) { threw = e; }
    const ms = Date.now() - t0;
    assert.ok(threw, 'should have thrown');
    assert.ok(messageHits === 1, `should have made exactly one request, made ${messageHits}`);
    assert.ok(ms < 2000, `should not back off, waited ${ms} ms`);
    const banner = humanizeLLMError(threw);
    assert.ok(/100% used/.test(banner), banner);
    assert.strictEqual(threw.retryHopeless, true);
  });

  restoreFetch();

  console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})();
