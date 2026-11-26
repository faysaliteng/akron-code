'use strict';
// What the user actually reads when a turn fails.
//
// The reported banner was:
//
//   The provider says that model or endpoint does not exist —
//   model 'claude-fable-5-2' not found
//
// That sentence is ours (`humanizeLLMError`'s 404 line) plus whatever body the
// endpoint returned. It was undiagnosable, because "model or endpoint does not
// exist" is equally true of a wrong path, a gateway that has never heard of the
// id, and a genuinely retired model. These tests pin the fix: a 404 names the
// URL that answered, and no other status is tempted to.
//
// Run: node test/error-banner.test.js

const assert = require('assert');
const path = require('path');

const { humanizeLLMError } = require(path.join(__dirname, '..', 'electron', 'llm.js'));

let pass = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function err(status, body, extra) {
  const e = new Error('LLM ' + status + ': ' + body);
  e.status = status;
  Object.assign(e, extra || {});
  return e;
}

t('the reported banner is reproduced verbatim from a body', () => {
  const banner = humanizeLLMError(err(404, JSON.stringify({ error: { message: "model 'claude-fable-5-2' not found" } })));
  assert.match(banner, /^The provider says that model or endpoint does not exist/);
  assert.match(banner, /model 'claude-fable-5-2' not found/);
});

t('a 404 names the URL that answered', () => {
  const banner = humanizeLLMError(err(404, JSON.stringify({ error: { message: "model 'claude-fable-5-2' not found" } }), {
    endpoint: 'https://api.anthropic.com/v1/messages',
  }));
  assert.match(banner, /\(asked api\.anthropic\.com\/v1\/messages\)/, banner);
  // The provider's own words survive — we name the endpoint, we do not replace it.
  assert.match(banner, /model 'claude-fable-5-2' not found/, banner);
});

t('a redirecting gateway shows the host it landed on, not the one we typed', () => {
  const banner = humanizeLLMError(err(404, 'not found', { endpoint: 'https://gw.example.net/v1/chat/completions' }));
  assert.match(banner, /asked gw\.example\.net\/v1\/chat\/completions/);
});

t('no endpoint, no parentheses — never an empty "(asked )"', () => {
  const banner = humanizeLLMError(err(404, 'not found'));
  assert.strictEqual(banner.includes('asked'), false, banner);
});

t('an unparseable endpoint is dropped, not printed raw', () => {
  const banner = humanizeLLMError(err(404, 'not found', { endpoint: 'not a url' }));
  assert.strictEqual(banner.includes('asked'), false, banner);
});

t('the endpoint is only named for 404 — a 500 keeps its own wording', () => {
  const banner = humanizeLLMError(err(500, 'boom', { endpoint: 'https://api.anthropic.com/v1/messages' }));
  assert.strictEqual(banner.includes('asked'), false, banner);
  assert.match(banner, /internal error|boom/i, banner);
});

t('a 429 still never mentions an endpoint', () => {
  const banner = humanizeLLMError(err(429, '{"type":"rate_limit_error","message":"Error"}', {
    endpoint: 'https://api.anthropic.com/v1/messages',
  }));
  assert.strictEqual(banner.includes('asked'), false, banner);
  assert.match(banner, /rate limiting/i, banner);
});

// Anthropic's long-context wall arrives as a 429, so the generic 429 line told
// the user their key was being throttled. It is not throttling: no retry can
// succeed until credits are added. This is the banner the packaged long-context
// probe actually produced (request_id req_011ChQjpsFodf64MrFbEgPvQ).
t('a 429 that names a credit wall is not called rate limiting', () => {
  const banner = humanizeLLMError(err(429, JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Usage credits are required for long context requests.' },
  })));
  assert.match(banner, /^This account needs usage credits for that request/, banner);
  assert.strictEqual(/rate limiting/i.test(banner), false, banner);
  // The provider's own words are still quoted, not replaced.
  assert.match(banner, /Usage credits are required for long context requests/, banner);
});

t('a plain token-per-minute 429 keeps the rate-limit wording', () => {
  const banner = humanizeLLMError(err(429, '{"type":"error","error":{"message":"Number of request tokens has exceeded your per-minute rate limit"}}'));
  assert.match(banner, /rate limiting/i, banner);
  assert.strictEqual(/usage credits/i.test(banner), false, banner);
});

t('a credit-wall banner does not repeat itself', () => {
  const banner = humanizeLLMError(err(429, '{"error":{"message":"Your credit balance is too low"}}'));
  const hits = (banner.match(/credit/gi) || []).length;
  assert.ok(hits <= 2, banner);
});

// The transport now stops the retry ladder for a long-context credit wall and
// hands us its own prose. Prove the shipped sentence is what the user sees, and
// that it is not dressed up as throttling.
t('a long-context credit wall shows the transport prose, not "rate limiting"', () => {
  const banner = humanizeLLMError(err(429, JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Usage credits are required for long context requests.' },
  }), {
    hint: 'Long context needs usage credits on this account — the plan allowance does not cover a request this large. Send a shorter conversation, or pick a model whose window fits it',
    retryHopeless: true,
  }));
  assert.match(banner, /^Long context needs usage credits/, banner);
  assert.strictEqual(/rate limiting/i.test(banner), false, banner);
});

t('the allowance hint still wins over everything (no endpoint appended)', () => {
  const banner = humanizeLLMError(err(429, '{"type":"rate_limit_error"}', {
    hint: "the Claude plan's 5-hour allowance is 100% used (resets 2:29 AM, in 65 min); send this request again after the reset — nothing in the conversation is lost",
    retryHopeless: true,
    endpoint: 'https://api.anthropic.com/v1/messages',
  }));
  assert.match(banner, /^The Claude plan's 5-hour allowance is 100% used/, banner);
  assert.strictEqual(banner.includes('asked'), false, banner);
});

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
process.exit(0);
