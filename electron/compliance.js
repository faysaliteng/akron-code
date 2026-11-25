'use strict';
// Organization data-classification compliance — the Desktop `taint:` namespace.
//
// `taint:*` is *not* data-flow taint tracking. It is the set of capability strings
// that claude.ai's account API returns per membership
// (`account.memberships[].organization.capabilities`), and Desktop turns each one
// into a concrete policy gate: MCP tool-switch sync, cloud/model moves, session
// deletion, product feedback, deployment overlay. Helio Bot has no account
// backend, so the profile is declared locally (Settings → Compliance) and every
// gate below is derived with the same arithmetic Desktop uses.
//
// Extracted contract (Desktop 7.37095.0):
//   RETENTION_FLAGS = ["zero_retention_lock","retain_restricted_pii",
//                      "no_anthropic_human_review_enabled"]
//   TERMS_PREFIX    = "taint:limit-to-service-terms-"
//   isCapability(c) = c.startsWith("taint:") || RETENTION_FLAGS.includes(c)
//   CHAT_SAFE       = ["taint:ferpa_regulated","taint:disable_product_feedback"]
//   MARKED          = ["taint:hipaa_regulated","taint:claude_code_zdr",
//                      "zero_retention_lock","taint:internal_limited_retention",
//                      "taint:legal_ops"]
//   CLOUD_MOVE      = { claude_code_zdr:"zero_retention",
//                       ant_hipi|cmek|internal_limited_retention:"cloud_disabled" }
//   DELETION_REFUSED = [refused_under_hipaa_configuration,
//                       refused_under_claude_code_zdr,
//                       refused_too_many_organizations]
//
// Pure Node — no Electron — so it is testable headless.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.autobot');

// All persistence resolves through `dataDir()` so a test can point the module at
// a scratch folder instead of the real `~/.autobot`.
let dataDirOverride = process.env.AUTOBOT_COMPLIANCE_DIR || null;
function dataDir() {
  return dataDirOverride || path.join(os.homedir(), '.autobot');
}
function profileFile() {
  return path.join(dataDir(), 'compliance.json');
}
function auditFile() {
  return path.join(dataDir(), 'compliance-audit.jsonl');
}
function setDataDir(dir) {
  dataDirOverride = dir ? String(dir) : null;
  cache = null;
  return dataDir();
}

const TERMS_PREFIX = 'taint:limit-to-service-terms-';

const RETENTION_FLAGS = [
  'zero_retention_lock',
  'retain_restricted_pii',
  'no_anthropic_human_review_enabled',
];

const CHAT_SAFE = ['taint:ferpa_regulated', 'taint:disable_product_feedback'];

const MARKED = [
  'taint:hipaa_regulated',
  'taint:claude_code_zdr',
  'zero_retention_lock',
  'taint:internal_limited_retention',
  'taint:legal_ops',
];

const CLOUD_MOVE_BLOCKS = new Map([
  ['taint:claude_code_zdr', 'zero_retention'],
  ['taint:ant_hipi', 'cloud_disabled'],
  ['taint:cmek', 'cloud_disabled'],
  ['taint:internal_limited_retention', 'cloud_disabled'],
]);

const DELETION_REFUSED = [
  'refused_under_hipaa_configuration',
  'refused_under_claude_code_zdr',
  'refused_too_many_organizations',
];

// ---------------------------------------------------------------------------
// Capability registry — the 12 `taint:*` strings plus the 4 related flags
// ---------------------------------------------------------------------------
const TAINT_ROWS = [
  {
    id: 'taint:hipaa_regulated',
    label: 'HIPAA-regulated workspace',
    summary: 'The organization is marked as handling protected health information.',
    effects: ['Blocks syncing MCP tool toggles to the account', 'Session deletion refused', 'Counts toward the marked-retention set'],
  },
  {
    id: 'taint:claude_code_zdr',
    label: 'Code zero-data-retention',
    summary: 'Sessions on this workspace are covered by a zero-data-retention agreement.',
    effects: ['Blocks cloud and model-overlay moves', 'Withholds site framing in the browser pane', 'Session deletion refused'],
  },
  {
    id: 'taint:ant_hipi',
    label: 'Highly sensitive data (hosted)',
    summary: 'The organization carries a highly-sensitive-data designation on hosted inference.',
    effects: ['Blocks cloud and model-overlay moves'],
  },
  {
    id: 'taint:cmek',
    label: 'Customer-managed encryption keys',
    summary: 'Inference data is encrypted with keys the organization controls.',
    effects: ['Blocks cloud and model-overlay moves', 'CMEK is treated as blocked for workbench actions'],
  },
  {
    id: 'taint:internal_limited_retention',
    label: 'Internal, limited retention',
    summary: 'Internal organization with a capped retention window.',
    effects: ['Blocks cloud and model-overlay moves', 'Counts toward the marked-retention set'],
  },
  {
    id: 'taint:aws_managed',
    label: 'AWS-managed deployment',
    summary: 'The organization is served from an AWS-managed deployment.',
    effects: ['Deployment overlay: AWS region', 'Pending visibility hides the deployment state'],
  },
  {
    id: 'taint:gcp_managed',
    label: 'GCP-managed deployment',
    summary: 'The organization is served from a GCP-managed deployment.',
    effects: ['Deployment overlay: GCP region', 'Pending visibility hides the deployment state'],
  },
  {
    id: 'taint:hybrid_3p',
    label: 'Hybrid / third-party deployment',
    summary: 'Desktop deployment is required for this organization.',
    effects: ['Marks Desktop as the required client', 'Reported as a third-party owner'],
  },
  {
    id: 'taint:ferpa_regulated',
    label: 'FERPA-regulated workspace',
    summary: 'Education records are in scope; chat stays available.',
    effects: ['Chat remains allowed', 'Product feedback is turned off'],
  },
  {
    id: 'taint:disable_product_feedback',
    label: 'Product feedback disabled',
    summary: 'The organization has opted out of product-feedback collection.',
    effects: ['Chat remains allowed', 'Product feedback is turned off'],
  },
  {
    id: 'taint:legal_ops',
    label: 'Legal-ops hold',
    summary: 'The organization is under a legal-operations retention hold.',
    effects: ['Counts toward the marked-retention set'],
  },
  {
    id: TERMS_PREFIX + '*',
    label: 'Service-terms limitation',
    summary: 'Prefix capability (`taint:limit-to-service-terms-<term>`). Explicitly exempt from every gate.',
    effects: ['No gate — treated as untainted'],
    prefix: true,
  },
];

const RELATED_ROWS = [
  {
    id: 'zero_retention_lock',
    label: 'Zero-retention lock',
    summary: 'The organization is locked to zero retention outside the `taint:` namespace.',
    effects: ['Counts toward the marked-retention set', 'Requires deletion auditing'],
  },
  {
    id: 'retain_restricted_pii',
    label: 'Restricted PII retention',
    summary: 'Restricted personal data must be retained.',
    effects: ['Requires deletion auditing'],
  },
  {
    id: 'no_anthropic_human_review_enabled',
    label: 'No human review',
    summary: 'Human review of the organization’s data is disabled.',
    effects: ['Informational only'],
  },
  {
    id: 'cmek_eligible',
    label: 'CMEK eligible',
    summary: 'The organization may use customer-managed encryption keys.',
    effects: ['Combines with the workbench block flag to resolve CMEK state'],
  },
];

const CATALOG = new Map();
for (const row of TAINT_ROWS.concat(RELATED_ROWS)) CATALOG.set(row.id, row);

// ---------------------------------------------------------------------------
// Capability predicates (Desktop `x2t` / `b2t` / `S2t` / `C2t`)
// ---------------------------------------------------------------------------
function isTermsLimited(cap) {
  return typeof cap === 'string' && cap.startsWith(TERMS_PREFIX);
}

function isTaint(cap) {
  return typeof cap === 'string' && cap.startsWith('taint:');
}

function isCapability(cap) {
  return isTaint(cap) || RETENTION_FLAGS.includes(cap);
}

// Desktop `C2t`: chat is only served when no capability outside CHAT_SAFE and the
// service-terms prefix is present.
function chatAllowed(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (!caps.includes('chat')) return false;
  if (caps.includes('raven') || caps.includes('api')) return false;
  return !caps.some((c) => isTaint(c) && !CHAT_SAFE.includes(c) && !isTermsLimited(c));
}

// Desktop `w2t`: paid chat plans (Claude Pro / Max) gated the same way.
function chatPlanAllowed(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  return chatAllowed(caps) && (caps.includes('claude_pro') || caps.includes('claude_max'));
}

function normalizeCapabilities(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const cap = raw.trim();
    if (!cap || cap.length > 200 || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Retention verdict (Desktop `yee`) — allowed / marked / unknown
// ---------------------------------------------------------------------------
function retentionVerdict(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (!caps.length) return 'unknown';
  if (MARKED.some((c) => caps.includes(c))) return 'marked';
  const retention = profile ? profile.dataRetention : undefined;
  if (retention == null) return 'unknown';
  return retention === 'default' ? 'allowed' : 'marked';
}

// Desktop `Wvr` — HIPAA tri-state.
function hipaaVerdict(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  const retention = profile ? profile.dataRetention : undefined;
  if (caps.includes('taint:hipaa_regulated')) return 'regulated';
  const otherMark =
    (retention != null && retention !== 'default') ||
    caps.some(
      (c) =>
        c !== 'taint:hipaa_regulated' &&
        (/hipaa|fedramp/i.test(c) || (isCapability(c) && !isTermsLimited(c))),
    );
  if (caps.length > 0 && !otherMark && retention === 'default') return 'not_regulated';
  return 'not_known';
}

// Desktop `Mvr` — CMEK blocked resolution.
function cmekBlocked(profile, force) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (caps.includes('taint:cmek')) return true;
  const eligible = caps.includes('cmek_eligible');
  if (!force && !eligible) return null;
  const blocked = profile ? profile.isWorkbenchCmekBlocked : null;
  if (blocked === true) return true;
  if (blocked === false && eligible) return false;
  return null;
}

// Desktop cloud-move policy (`C` map in the cloud-move chunk).
function cloudMovePolicy(profile, extraBlockers) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (!caps.length) return { verdict: 'unverified' };
  for (const [cap, why] of CLOUD_MOVE_BLOCKS) {
    if (caps.includes(cap)) return { verdict: 'blocked', why };
  }
  const extra = Array.isArray(extraBlockers) ? extraBlockers : [];
  if (extra.some((c) => caps.includes(c))) return { verdict: 'blocked', why: 'cloud_disabled' };
  return { verdict: 'allowed' };
}

// Desktop deployment overlay (`mw` / `NLn` / `PLn` / `FLn` / `ILn`).
function deploymentMode(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  if (caps.includes('taint:hybrid_3p')) return 'hybrid';
  if (caps.includes('taint:aws_managed')) return 'aws';
  if (caps.includes('taint:gcp_managed')) return 'gcp';
  return 'standard';
}

function deploymentPending(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  const cloud = caps.includes('taint:aws_managed') || caps.includes('taint:gcp_managed');
  return cloud && profile && profile.visibilityStatus === 'pending';
}

// Desktop `Mvr` companion — Desktop is the required client for hybrid orgs.
function desktopRequired(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  return caps.includes('taint:hybrid_3p') && !!(profile && profile.desktopDeploymentRequired !== false);
}

function sessionLength(profile) {
  const raw = profile ? profile.sessionLengthSeconds : null;
  if (raw === null || raw === undefined) return 'never_set';
  if (raw === -1) return 'never_set';
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return raw;
  return 'unread';
}

// Desktop `m()` — does this profile require an audit record on session deletion?
function deletionAuditRequired(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  const retention = profile ? profile.dataRetention : null;
  if (retention !== null && retention !== undefined && retention !== 'default') return true;
  return caps.some(
    (c) => (isTaint(c) && !isTermsLimited(c)) || c === 'zero_retention_lock' || c === 'retain_restricted_pii',
  );
}

// ---------------------------------------------------------------------------
// Gates — one function per Desktop enforcement point
// ---------------------------------------------------------------------------
// Desktop blocks PATCHing the enabled-MCP-tools set to the account under HIPAA.
// Helio Bot keeps that set on disk, so the gate is expressed as "local only".
function mcpToolSwitch(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (caps.includes('taint:hipaa_regulated')) {
    return { allowed: false, reason: 'hipaa', mode: 'local-only' };
  }
  return { allowed: true, mode: 'local-only' };
}

// Desktop refuses session deletion outright under HIPAA / ZDR.
function sessionDeletion(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (caps.includes('taint:hipaa_regulated')) {
    return { allowed: false, reason: 'refused_under_hipaa_configuration' };
  }
  if (caps.includes('taint:claude_code_zdr')) {
    return { allowed: false, reason: 'refused_under_claude_code_zdr' };
  }
  return { allowed: true, audit: deletionAuditRequired(profile) };
}

function productFeedback(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  if (caps.includes('taint:disable_product_feedback') || caps.includes('taint:ferpa_regulated')) {
    return { allowed: false, reason: 'org_policy' };
  }
  return { allowed: true };
}

// Browser pane framing is withheld under ZDR (Desktop drops the site chrome).
function siteFraming(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  return caps.includes('taint:claude_code_zdr') ? { allowed: false, reason: 'zero_retention' } : { allowed: true };
}

// ---------------------------------------------------------------------------
// Human-readable copy for each blocked state
// ---------------------------------------------------------------------------
const LINES = {
  hipaa_toolswitch:
    'Your organization’s HIPAA configuration blocks syncing MCP tool toggles to the account. Toggles apply on this device only.',
  cloud_zero_retention:
    'Your organization retains no data on this service, so this session can’t be moved to the cloud.',
  cloud_disabled:
    'Your organization’s policy disables cloud processing for this workspace.',
  deletion_hipaa:
    'This session can’t be deleted while the workspace is marked HIPAA-regulated.',
  deletion_zdr:
    'This session can’t be deleted under your organization’s zero-data-retention configuration.',
  feedback_off: 'Product feedback is turned off by your organization’s policy.',
  framing_off: 'Site framing is withheld under your organization’s zero-data-retention configuration.',
  allowed: 'No organizational restriction applies to this workspace.',
  unknown: 'No organization profile is set, so restrictions are unknown.',
  unverified: 'The organization’s record could not be read, so this action is unverified.',
};

function cloudMoveLine(policy) {
  if (!policy || policy.verdict === 'allowed') return LINES.allowed;
  if (policy.verdict === 'unverified') return LINES.unverified;
  return policy.why === 'zero_retention' ? LINES.cloud_zero_retention : LINES.cloud_disabled;
}

function deletionLine(decision) {
  if (!decision || decision.allowed) return '';
  return decision.reason === 'refused_under_hipaa_configuration' ? LINES.deletion_hipaa : LINES.deletion_zdr;
}

function describeCapability(cap) {
  if (!cap || typeof cap !== 'string') return null;
  const row = CATALOG.get(cap);
  if (row) return { ...row, active: true };
  if (isTermsLimited(cap)) {
    const term = cap.slice(TERMS_PREFIX.length) || 'unspecified';
    return {
      id: cap,
      label: 'Service-terms limitation',
      summary: `Prefix capability \`${TERMS_PREFIX}${term}\` — exempt from every gate.`,
      effects: ['No gate — treated as untainted'],
      prefix: true,
      term,
      active: true,
    };
  }
  if (isTaint(cap)) {
    return {
      id: cap,
      label: 'Unknown taint capability',
      summary: 'Not present in the Desktop 7.37095.0 capability set; treated as restricting.',
      effects: ['Counts toward the marked-retention set', 'Not exempt from cloud-move blocks'],
      unknown: true,
      active: true,
    };
  }
  return null;
}

function catalog() {
  return TAINT_ROWS.concat(RELATED_ROWS).map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Full snapshot — one evaluation the UI can render directly
// ---------------------------------------------------------------------------
function evaluate(profile) {
  const caps = normalizeCapabilities(profile && profile.capabilities);
  const retention = retentionVerdict(profile);
  const hipaa = hipaaVerdict(profile);
  const cloudMove = cloudMovePolicy(profile);
  const toolSwitch = mcpToolSwitch(profile);
  const deletion = sessionDeletion(profile);
  const feedback = productFeedback(profile);
  const framing = siteFraming(profile);
  const deployment = deploymentMode(caps);
  const audit = deletionAuditRequired(profile);

  const marks = caps.map(describeCapability).filter(Boolean);

  let tone = 'ok';
  if (!caps.length) tone = 'unknown';
  else if (!cloudMove.verdict || cloudMove.verdict === 'unverified') tone = 'unknown';
  else if (cloudMove.verdict === 'blocked' || !deletion.allowed) tone = 'blocked';
  else if (retention === 'marked' || hipaa === 'regulated' || audit) tone = 'warn';

  const headline =
    tone === 'unknown'
      ? LINES.unknown
      : tone === 'blocked'
        ? (cloudMove.verdict === 'blocked' ? cloudMoveLine(cloudMove) : deletionLine(deletion))
        : tone === 'warn'
          ? 'This workspace is marked for restricted handling; destructive actions are audited.'
          : LINES.allowed;

  return {
    capabilities: caps,
    dataRetention: profile ? profile.dataRetention : null,
    markedCount: caps.filter((c) => isCapability(c) && !isTermsLimited(c)).length,
    retention,
    hipaa,
    cmek: cmekBlocked(profile),
    cloudMove,
    cloudMoveLine: cloudMoveLine(cloudMove),
    toolSwitch,
    toolSwitchLine: toolSwitch.allowed ? '' : LINES.hipaa_toolswitch,
    deletion,
    deletionLine: deletionLine(deletion),
    feedback,
    feedbackLine: feedback.allowed ? '' : LINES.feedback_off,
    framing,
    framingLine: framing.allowed ? '' : LINES.framing_off,
    deployment,
    deploymentPending: deploymentPending(profile),
    desktopRequired: desktopRequired(profile),
    sessionLength: sessionLength(profile),
    audit,
    chat: { allowed: chatAllowed(caps), planAllowed: chatPlanAllowed(caps) },
    marks,
    tone,
    headline,
  };
}

// ---------------------------------------------------------------------------
// Local profile persistence (~/.autobot/compliance.json)
// ---------------------------------------------------------------------------
const DEFAULT_PROFILE = {
  organization: '',
  capabilities: [],
  dataRetention: 'default',
  sessionLengthSeconds: null,
  isWorkbenchCmekBlocked: null,
  visibilityStatus: null,
  updatedAt: null,
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return fallback;
}

function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const retention = typeof p.dataRetention === 'string' && p.dataRetention ? p.dataRetention : 'default';
  const session = typeof p.sessionLengthSeconds === 'number' && Number.isFinite(p.sessionLengthSeconds)
    ? p.sessionLengthSeconds
    : null;
  const cmek = p.isWorkbenchCmekBlocked === true || p.isWorkbenchCmekBlocked === false
    ? p.isWorkbenchCmekBlocked
    : null;
  return {
    organization: typeof p.organization === 'string' ? p.organization.slice(0, 120) : '',
    capabilities: normalizeCapabilities(p.capabilities),
    dataRetention: retention.slice(0, 64),
    sessionLengthSeconds: session,
    isWorkbenchCmekBlocked: cmek,
    visibilityStatus: p.visibilityStatus === 'pending' ? 'pending' : null,
    desktopDeploymentRequired: p.desktopDeploymentRequired === false ? false : true,
    updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
  };
}

let cache = null;

function getProfile() {
  if (cache) return cache;
  cache = normalizeProfile(readJSON(profileFile(), DEFAULT_PROFILE));
  return cache;
}

function setProfile(patch) {
  const next = normalizeProfile({ ...getProfile(), ...(patch && typeof patch === 'object' ? patch : {}) });
  next.updatedAt = new Date().toISOString();
  cache = next;
  try {
    ensureDir(dataDir());
    fs.writeFileSync(profileFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (_) {}
  return next;
}

function resetProfile() {
  cache = null;
  try {
    if (fs.existsSync(profileFile())) fs.unlinkSync(profileFile());
  } catch (_) {}
  cache = normalizeProfile(DEFAULT_PROFILE);
  return cache;
}

function snapshot(profile) {
  const p = profile ? normalizeProfile(profile) : getProfile();
  return { profile: p, state: evaluate(p), catalog: catalog() };
}

// ---------------------------------------------------------------------------
// Deletion ledger — Desktop writes an audit record when a session is deleted
// under a marked-retention profile (`m()` predicate). Same idea here, append
// only, capped on read.
// ---------------------------------------------------------------------------
const AUDIT_MAX_BYTES = 512 * 1024;

function recordDeletion(entry) {
  const profile = getProfile();
  const row = {
    at: new Date().toISOString(),
    conversationId: entry && entry.id ? String(entry.id).slice(0, 120) : null,
    title: entry && entry.title ? String(entry.title).slice(0, 200) : null,
    organization: profile.organization || null,
    capabilities: profile.capabilities,
    dataRetention: profile.dataRetention,
    reason: entry && entry.reason ? String(entry.reason).slice(0, 80) : 'user_deleted',
  };
  const file = auditFile();
  try {
    ensureDir(dataDir());
    // Rotate once past the cap rather than growing without bound.
    try {
      const stat = fs.statSync(file);
      if (stat.size > AUDIT_MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch (_) {}
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch (_) {}
  return row;
}

function readAudit(limit) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  let text = '';
  try {
    if (fs.existsSync(auditFile())) text = fs.readFileSync(auditFile(), 'utf8');
  } catch (_) {}
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    try { out.push(JSON.parse(lines[i])); } catch (_) {}
  }
  return out;
}

module.exports = {
  DATA_DIR,
  dataDir,
  profileFile,
  auditFile,
  setDataDir,
  DEFAULT_PROFILE,
  TERMS_PREFIX,
  RETENTION_FLAGS,
  CHAT_SAFE,
  MARKED,
  CLOUD_MOVE_BLOCKS,
  DELETION_REFUSED,
  LINES,
  isTaint,
  isCapability,
  isTermsLimited,
  chatAllowed,
  chatPlanAllowed,
  normalizeCapabilities,
  retentionVerdict,
  hipaaVerdict,
  cmekBlocked,
  cloudMovePolicy,
  deploymentMode,
  deploymentPending,
  desktopRequired,
  sessionLength,
  deletionAuditRequired,
  mcpToolSwitch,
  sessionDeletion,
  productFeedback,
  siteFraming,
  describeCapability,
  catalog,
  evaluate,
  normalizeProfile,
  getProfile,
  setProfile,
  resetProfile,
  snapshot,
  recordDeletion,
  readAudit,
};
