'use strict';
// Organization compliance — the Desktop `taint:*` capability namespace.
//
// Every assertion below mirrors arithmetic extracted from the Desktop
// 7.37095.0 bundle: retention tri-state, HIPAA tri-state, CMEK resolution, the
// cloud-move policy map, chat gating, deployment overlays, deletion refusal and
// the deletion-audit predicate. No network, no Electron.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../electron/compliance');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-compliance-'));
c.setDataDir(dir);

// ---------------------------------------------------------------------------
console.log('\ncompliance — capability predicates');
// ---------------------------------------------------------------------------
ok('isTaint on a taint capability', c.isTaint('taint:hipaa_regulated'));
ok('isTaint off for a retention flag', !c.isTaint('zero_retention_lock'));
ok('retention flags count as capabilities', c.isCapability('retain_restricted_pii'));
ok('plain account caps are not capabilities', !c.isCapability('chat'));
ok('terms prefix is a taint capability', c.isTaint('taint:limit-to-service-terms-nda'));
ok('terms prefix detected', c.isTermsLimited('taint:limit-to-service-terms-nda'));
ok('terms prefix is not matched loosely', !c.isTermsLimited('taint:limit-to-service_terms'));

// ---------------------------------------------------------------------------
console.log('\ncompliance — normalization');
// ---------------------------------------------------------------------------
eq('drops non-strings and blanks', c.normalizeCapabilities(['chat', '', 5, null, '  ']), ['chat']);
eq('trims', c.normalizeCapabilities(['  taint:cmek  ']), ['taint:cmek']);
eq('dedupes', c.normalizeCapabilities(['a', 'a', 'b']), ['a', 'b']);
ok('caps a 250-char capability', c.normalizeCapabilities(['x'.repeat(250)]).length === 0);
ok('caps the list at 200', c.normalizeCapabilities(Array.from({ length: 300 }, (_, i) => 'cap' + i)).length === 200);

// ---------------------------------------------------------------------------
console.log('\ncompliance — retention verdict (yee)');
// ---------------------------------------------------------------------------
eq('no caps → unknown', c.retentionVerdict({ capabilities: [] }), 'unknown');
eq('clean caps + default → allowed', c.retentionVerdict({ capabilities: ['chat'], dataRetention: 'default' }), 'allowed');
eq('marked capability → marked', c.retentionVerdict({ capabilities: ['taint:legal_ops'], dataRetention: 'default' }), 'marked');
eq('zero_retention_lock → marked', c.retentionVerdict({ capabilities: ['zero_retention_lock'], dataRetention: 'default' }), 'marked');
eq('non-default retention → marked', c.retentionVerdict({ capabilities: ['chat'], dataRetention: 'none' }), 'marked');
eq('null retention with caps → unknown', c.retentionVerdict({ capabilities: ['chat'], dataRetention: null }), 'unknown');
eq('terms prefix does not mark', c.retentionVerdict({ capabilities: ['taint:limit-to-service-terms-a'], dataRetention: 'default' }), 'allowed');

// ---------------------------------------------------------------------------
console.log('\ncompliance — HIPAA tri-state (Wvr)');
// ---------------------------------------------------------------------------
eq('explicit → regulated', c.hipaaVerdict({ capabilities: ['taint:hipaa_regulated'], dataRetention: 'default' }), 'regulated');
eq('clean + default → not_regulated', c.hipaaVerdict({ capabilities: ['chat'], dataRetention: 'default' }), 'not_regulated');
eq('no caps → not_known', c.hipaaVerdict({ capabilities: [], dataRetention: 'default' }), 'not_known');
eq('non-default retention → not_known', c.hipaaVerdict({ capabilities: ['chat'], dataRetention: 'none' }), 'not_known');
eq('other taint cap → not_known', c.hipaaVerdict({ capabilities: ['chat', 'taint:cmek'], dataRetention: 'default' }), 'not_known');
eq('terms prefix does not block not_regulated', c.hipaaVerdict({ capabilities: ['chat', 'taint:limit-to-service-terms-a'], dataRetention: 'default' }), 'not_regulated');
eq('fedramp substring → not_known', c.hipaaVerdict({ capabilities: ['chat', 'fedramp_high'], dataRetention: 'default' }), 'not_known');
eq('missing retention → not_known', c.hipaaVerdict({ capabilities: ['chat'] }), 'not_known');

// ---------------------------------------------------------------------------
console.log('\ncompliance — CMEK (Mvr)');
// ---------------------------------------------------------------------------
eq('taint:cmek → true', c.cmekBlocked({ capabilities: ['taint:cmek'] }), true);
eq('not eligible, not forced → null', c.cmekBlocked({ capabilities: ['chat'] }), null);
eq('eligible + blocked flag → true', c.cmekBlocked({ capabilities: ['cmek_eligible'], isWorkbenchCmekBlocked: true }), true);
eq('eligible + false flag → false', c.cmekBlocked({ capabilities: ['cmek_eligible'], isWorkbenchCmekBlocked: false }), false);
eq('eligible + unknown flag → null', c.cmekBlocked({ capabilities: ['cmek_eligible'] }), null);
eq('forced + false flag → null (not eligible)', c.cmekBlocked({ capabilities: ['chat'], isWorkbenchCmekBlocked: false }, true), null);
eq('forced + true flag → true', c.cmekBlocked({ capabilities: ['chat'], isWorkbenchCmekBlocked: true }, true), true);

// ---------------------------------------------------------------------------
console.log('\ncompliance — cloud-move policy');
// ---------------------------------------------------------------------------
eq('no caps → unverified', c.cloudMovePolicy({ capabilities: [] }), { verdict: 'unverified' });
eq('clean caps → allowed', c.cloudMovePolicy({ capabilities: ['chat'] }), { verdict: 'allowed' });
eq('zdr → blocked/zero_retention', c.cloudMovePolicy({ capabilities: ['taint:claude_code_zdr'] }), { verdict: 'blocked', why: 'zero_retention' });
eq('ant_hipi → blocked/cloud_disabled', c.cloudMovePolicy({ capabilities: ['taint:ant_hipi'] }), { verdict: 'blocked', why: 'cloud_disabled' });
eq('cmek → blocked/cloud_disabled', c.cloudMovePolicy({ capabilities: ['taint:cmek'] }), { verdict: 'blocked', why: 'cloud_disabled' });
eq('internal_limited_retention → blocked', c.cloudMovePolicy({ capabilities: ['taint:internal_limited_retention'] }), { verdict: 'blocked', why: 'cloud_disabled' });
eq('extra blockers honoured', c.cloudMovePolicy({ capabilities: ['chat'] }, ['chat']), { verdict: 'blocked', why: 'cloud_disabled' });
eq('extra blocker must be present', c.cloudMovePolicy({ capabilities: ['chat'] }, ['raven']), { verdict: 'allowed' });
eq('terms prefix does not block', c.cloudMovePolicy({ capabilities: ['taint:limit-to-service-terms-a'] }), { verdict: 'allowed' });

// ---------------------------------------------------------------------------
console.log('\ncompliance — chat gating (C2t / w2t)');
// ---------------------------------------------------------------------------
ok('chat requires the chat cap', !c.chatAllowed(['claude_max']));
ok('chat + claude_max allowed', c.chatAllowed(['chat', 'claude_max']));
ok('raven refuses chat', !c.chatAllowed(['chat', 'raven', 'claude_max']));
ok('api refuses chat', !c.chatAllowed(['chat', 'api']));
ok('hipaa refuses chat', !c.chatAllowed(['chat', 'taint:hipaa_regulated']));
ok('ferpa still allows chat', c.chatAllowed(['chat', 'taint:ferpa_regulated']));
ok('disable_product_feedback still allows chat', c.chatAllowed(['chat', 'taint:disable_product_feedback']));
ok('terms prefix still allows chat', c.chatAllowed(['chat', 'taint:limit-to-service-terms-a']));
ok('plan requires pro/max', !c.chatPlanAllowed(['chat']));
ok('plan with max allowed', c.chatPlanAllowed(['chat', 'claude_max']));
ok('plan with pro allowed', c.chatPlanAllowed(['chat', 'claude_pro']));
ok('plan refused under raven even with max', !c.chatPlanAllowed(['chat', 'raven', 'claude_max']));

// ---------------------------------------------------------------------------
console.log('\ncompliance — deployment overlay');
// ---------------------------------------------------------------------------
eq('aws', c.deploymentMode(['taint:aws_managed']), 'aws');
eq('gcp', c.deploymentMode(['taint:gcp_managed']), 'gcp');
eq('hybrid wins', c.deploymentMode(['taint:aws_managed', 'taint:hybrid_3p']), 'hybrid');
eq('standard', c.deploymentMode(['chat']), 'standard');
ok('pending only for cloud', c.deploymentPending({ capabilities: ['taint:aws_managed'], visibilityStatus: 'pending' }));
ok('pending ignored for standard', !c.deploymentPending({ capabilities: ['chat'], visibilityStatus: 'pending' }));
ok('non-pending visibility ignored', !c.deploymentPending({ capabilities: ['taint:gcp_managed'], visibilityStatus: 'ready' }));
ok('desktop required for hybrid', c.desktopRequired({ capabilities: ['taint:hybrid_3p'] }));
ok('desktop not required when overridden', !c.desktopRequired({ capabilities: ['taint:hybrid_3p'], desktopDeploymentRequired: false }));
ok('desktop not required for standard', !c.desktopRequired({ capabilities: ['chat'] }));

// ---------------------------------------------------------------------------
console.log('\ncompliance — session length');
// ---------------------------------------------------------------------------
eq('unset → never_set', c.sessionLength({}), 'never_set');
eq('-1 → never_set', c.sessionLength({ sessionLengthSeconds: -1 }), 'never_set');
eq('numeric passthrough', c.sessionLength({ sessionLengthSeconds: 3600 }), 3600);
eq('zero → unread', c.sessionLength({ sessionLengthSeconds: 0 }), 'unread');
eq('string → unread', c.sessionLength({ sessionLengthSeconds: '3600' }), 'unread');

// ---------------------------------------------------------------------------
console.log('\ncompliance — deletion audit predicate (m)');
// ---------------------------------------------------------------------------
ok('no caps, default retention → no audit', !c.deletionAuditRequired({ capabilities: [], dataRetention: 'default' }));
ok('non-default retention → audit', c.deletionAuditRequired({ capabilities: [], dataRetention: 'none' }));
ok('taint cap → audit', c.deletionAuditRequired({ capabilities: ['taint:cmek'], dataRetention: 'default' }));
ok('terms prefix → no audit', !c.deletionAuditRequired({ capabilities: ['taint:limit-to-service-terms-a'], dataRetention: 'default' }));
ok('zero_retention_lock → audit', c.deletionAuditRequired({ capabilities: ['zero_retention_lock'] }));
ok('retain_restricted_pii → audit', c.deletionAuditRequired({ capabilities: ['retain_restricted_pii'] }));

// ---------------------------------------------------------------------------
console.log('\ncompliance — gates');
// ---------------------------------------------------------------------------
eq('tool switch allowed normally', c.mcpToolSwitch({ capabilities: ['chat'] }), { allowed: true, mode: 'local-only' });
eq('tool switch blocked under hipaa', c.mcpToolSwitch({ capabilities: ['taint:hipaa_regulated'] }), { allowed: false, reason: 'hipaa', mode: 'local-only' });

eq('delete allowed normally', c.sessionDeletion({ capabilities: ['chat'], dataRetention: 'default' }), { allowed: true, audit: false });
eq('delete audits under marked retention', c.sessionDeletion({ capabilities: ['taint:cmek'], dataRetention: 'default' }), { allowed: true, audit: true });
eq('delete refused under hipaa', c.sessionDeletion({ capabilities: ['taint:hipaa_regulated'] }), { allowed: false, reason: 'refused_under_hipaa_configuration' });
eq('delete refused under zdr', c.sessionDeletion({ capabilities: ['taint:claude_code_zdr'] }), { allowed: false, reason: 'refused_under_claude_code_zdr' });
eq('hipaa wins over zdr', c.sessionDeletion({ capabilities: ['taint:claude_code_zdr', 'taint:hipaa_regulated'] }).reason, 'refused_under_hipaa_configuration');

eq('feedback allowed normally', c.productFeedback({ capabilities: ['chat'] }), { allowed: true });
eq('feedback off under ferpa', c.productFeedback({ capabilities: ['taint:ferpa_regulated'] }), { allowed: false, reason: 'org_policy' });
eq('feedback off under explicit flag', c.productFeedback({ capabilities: ['taint:disable_product_feedback'] }), { allowed: false, reason: 'org_policy' });

eq('framing allowed normally', c.siteFraming({ capabilities: ['chat'] }), { allowed: true });
eq('framing withheld under zdr', c.siteFraming({ capabilities: ['taint:claude_code_zdr'] }), { allowed: false, reason: 'zero_retention' });

// ---------------------------------------------------------------------------
console.log('\ncompliance — catalogue + describe');
// ---------------------------------------------------------------------------
const cat = c.catalog();
ok('catalogue has 16 rows', cat.length === 16, cat.length);
const ids = new Set(cat.map((r) => r.id));
for (const id of ['taint:hipaa_regulated', 'taint:claude_code_zdr', 'taint:ant_hipi', 'taint:cmek',
  'taint:internal_limited_retention', 'taint:aws_managed', 'taint:gcp_managed', 'taint:hybrid_3p',
  'taint:ferpa_regulated', 'taint:disable_product_feedback', 'taint:legal_ops',
  'zero_retention_lock', 'retain_restricted_pii', 'no_anthropic_human_review_enabled', 'cmek_eligible']) {
  ok('catalogue has ' + id, ids.has(id));
}
ok('catalogue documents the prefix row', ids.has(c.TERMS_PREFIX + '*'));

const known = c.describeCapability('taint:cmek');
ok('describe returns label + effects', known && known.label && Array.isArray(known.effects) && known.active === true);
const prefix = c.describeCapability('taint:limit-to-service-terms-nda');
ok('describe resolves a prefix capability', prefix && prefix.prefix === true && prefix.term === 'nda');
const unknown = c.describeCapability('taint:brand_new_thing');
ok('unknown taint is described conservatively', unknown && unknown.unknown === true);
eq('non-capability describes as null', c.describeCapability('chat'), null);
eq('non-string describes as null', c.describeCapability(42), null);

// ---------------------------------------------------------------------------
console.log('\ncompliance — evaluate snapshot');
// ---------------------------------------------------------------------------
const empty = c.evaluate({ capabilities: [], dataRetention: 'default' });
eq('empty tone', empty.tone, 'unknown');
eq('empty headline is the unknown line', empty.headline, c.LINES.unknown);
eq('empty cloud move is unverified', empty.cloudMove.verdict, 'unverified');

const clean = c.evaluate({ capabilities: ['chat', 'claude_max'], dataRetention: 'default' });
eq('clean tone', clean.tone, 'ok');
eq('clean headline', clean.headline, c.LINES.allowed);
ok('clean marks the chat gate open', clean.chat.allowed && clean.chat.planAllowed);

const hipaa = c.evaluate({ capabilities: ['chat', 'taint:hipaa_regulated'], dataRetention: 'default' });
eq('hipaa tone is blocked', hipaa.tone, 'blocked');
eq('hipaa headline explains deletion', hipaa.headline, c.LINES.deletion_hipaa);
eq('hipaa hipaa verdict', hipaa.hipaa, 'regulated');
ok('hipaa blocks the tool switch line', !!hipaa.toolSwitchLine);
ok('hipaa does not disable feedback (only FERPA/flag do)', !hipaa.feedbackLine);
eq('hipaa refuses chat', hipaa.chat.allowed, false);

const zdr = c.evaluate({ capabilities: ['chat', 'taint:claude_code_zdr'], dataRetention: 'default' });
eq('zdr tone is blocked', zdr.tone, 'blocked');
eq('zdr cloud move blocked', zdr.cloudMove, { verdict: 'blocked', why: 'zero_retention' });
eq('zdr headline is the cloud line', zdr.headline, c.LINES.cloud_zero_retention);
eq('zdr framing off', zdr.framing.allowed, false);

const marked = c.evaluate({ capabilities: ['chat', 'zero_retention_lock'], dataRetention: 'default' });
eq('marked tone is warn', marked.tone, 'warn');
ok('marked requires audit', marked.audit);
ok('marked counts marked capabilities', marked.markedCount === 1, marked.markedCount);

const terms = c.evaluate({ capabilities: ['chat', 'taint:limit-to-service-terms-x'], dataRetention: 'default' });
eq('terms profile tone stays ok', terms.tone, 'ok');
eq('terms profile is unmarked', terms.markedCount, 0);

// ---------------------------------------------------------------------------
console.log('\ncompliance — persistence + deletion ledger');
// ---------------------------------------------------------------------------
c.resetProfile();
const defaults = c.getProfile();
eq('reset leaves no capabilities', defaults.capabilities, []);
eq('reset restores default retention', defaults.dataRetention, 'default');
ok('profile writes to the overridden dir', c.profileFile().startsWith(dir), c.profileFile());

const saved = c.setProfile({ organization: 'Acme Health', capabilities: ['taint:hipaa_regulated'], dataRetention: 'none' });
eq('setProfile normalizes caps', saved.capabilities, ['taint:hipaa_regulated']);
ok('setProfile stamps updatedAt', !!saved.updatedAt);
ok('profile file exists on disk', fs.existsSync(c.profileFile()));

const reread = JSON.parse(fs.readFileSync(c.profileFile(), 'utf8'));
eq('profile persisted', reread.organization, 'Acme Health');

const row = c.recordDeletion({ id: 'conv-1', title: 'Test chat' });
eq('audit row records the reason default', row.reason, 'user_deleted');
eq('audit row records the org', row.organization, 'Acme Health');
const audit = c.readAudit(10);
eq('audit reads back one row', audit.length, 1);
eq('audit row round-trips', audit[0].conversationId, 'conv-1');

for (let i = 0; i < 4; i++) c.recordDeletion({ id: 'conv-' + i });
eq('readAudit honours the limit', c.readAudit(3).length, 3);
eq('readAudit is newest-first', c.readAudit(1)[0].conversationId, 'conv-3');

const snap = c.snapshot();
ok('snapshot carries profile + state + catalog', !!snap.profile && !!snap.state && Array.isArray(snap.catalog));

c.resetProfile();
ok('reset removes the profile file', !fs.existsSync(c.profileFile()));

c.setDataDir(null);
eq('setDataDir(null) restores the real home dir', c.dataDir(), path.join(os.homedir(), '.autobot'));

fs.rmSync(dir, { recursive: true, force: true });

console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
