// Claude allowance formatting, error banner prose, OAuth rejection in
// providertransport.js, and 429 hopelessness handling in llm.chatWithFailover.
// Run: node test/claude-allowance.test.js

'use strict';

const assert = require('assert');
const path = require('path');

const pt = require(path.join(__dirname, '..', 'electron', 'providertransport.js'));
const llm = require(path.join(__dirname, '..', 'electron', 'llm.js'));

const { formatResetIn } = pt._internal;
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

const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

(async () => {
  console.log('Claude allowance read-out & official API key enforcement');

  t('a reset a few minutes out reads as a clock time plus minutes', () => {
    const s = formatResetIn(new Date(Date.now() + 5 * 60000).toISOString());
    assert.ok(/, in 5 min$/.test(s), s);
  });

  t('an invalid reset timestamp renders as empty, never "Invalid Date"', () => {
    assert.strictEqual(formatResetIn('not a date'), '');
    assert.strictEqual(formatResetIn(undefined), '');
  });

  await ta('consumer OAuth tokens are rejected by direct HTTPS providertransport in favor of official CLI', async () => {
    let err = null;
    try {
      await pt.chatCompletion(
        { transport: 'anthropic', model: 'claude-sonnet-4-6', oauth: true, accessToken: 'sk-ant-oat01-fake' },
        [{ role: 'user', content: 'hi' }],
        null,
        () => {},
      );
    } catch (e) { err = e; }
    assert.ok(err, 'expected consumer OAuth rejection');
    assert.strictEqual(err.code, 'cli_transport_required');
  });

  await ta('the banner is one sentence, prose only, no vendor envelope', async () => {
    const e = new Error('LLM 429: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached"}}');
    e.status = 429;
    e.hint = "the Claude plan's 5-hour allowance is 100% used (resets 9:30 PM, in 5 min); send this request again after the reset — nothing in the conversation is lost";
    e.retryHopeless = true;
    const banner = humanizeLLMError(e);
    assert.ok(/5-hour allowance is 100% used/.test(banner), banner);
    assert.ok(!/[{}"<>]/.test(banner), 'envelope leaked into the banner: ' + banner);
    assert.ok(!/The provider is rate limiting this key — The provider is rate limiting this key/.test(banner), 'repeated head: ' + banner);
  });

  await ta('an exhausted window is not prefixed with "rate limiting this key"', async () => {
    const e = new Error('LLM 429: x');
    e.status = 429;
    e.hint = "the Claude plan's 5-hour allowance is 100% used (resets 9:30 PM, in 4 min); send this request again after the reset — nothing in the conversation is lost";
    e.retryHopeless = true;
    const banner = humanizeLLMError(e);
    assert.ok(banner.startsWith("The Claude plan's 5-hour allowance is 100% used"), banner);
    assert.ok(!/rate limiting this key/.test(banner), 'misleading head: ' + banner);
  });

  await ta('a 402 credit-wall stops backoff immediately via official API key transport', async () => {
    delete process.env.HELIO_BACKOFF_MS;
    let messageHits = 0;
    stubFetch(async () => {
      messageHits++;
      return {
        ok: false,
        status: 402,
        headers: { get: () => '' },
        text: async () => '{"type":"error","error":{"type":"credit_balance_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      };
    });
    const t0 = Date.now();
    let threw = null;
    try {
      await llm.chatWithFailover({
        list: [{ transport: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-ant-api03-test' }],
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
    assert.ok(/credit|balance|out of credit/i.test(banner), banner);
  });

  restoreFetch();

  console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
  process.exit(0);
})();
