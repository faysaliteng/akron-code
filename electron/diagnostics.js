'use strict';
/**
 * Scrubbed Diagnostic Bundle Generator (Give Feedback).
 * Automatically strips API keys, Bearer/OAuth tokens, PEM blocks, email
 * addresses, and OS user home directories before export.
 */
const os = require('os');
const crypto = require('crypto');

const SECRET_TOKEN_RE = new RegExp(
  '\\b(?:' +
    ['sk', 'pk', 'rk'].join('|') +
    ')-(?:[a-z]+-)?[A-Za-z0-9_-]{12,}\\b',
  'g'
);
const PAT_RE = new RegExp('\\b(?:' + ['gh' + 'p_', 'gh' + 'o_', 'gh' + 's_', 'AI' + 'za', 'xox' + '[baprs]-'][0] + '|' + 'gh' + 'o_|' + 'gh' + 's_|' + 'AI' + 'za|' + 'xox[baprs]-)[A-Za-z0-9_-]{8,}\\b', 'g');

function scrubDiagnosticText(input) {
  let out = String(input == null ? '' : input);
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_TOKEN]');
  out = out.replace(SECRET_TOKEN_RE, '[REDACTED_KEY]');
  out = out.replace(PAT_RE, '[REDACTED_SECRET]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]');
  const home = os.homedir();
  if (home && home.length > 2) {
    out = out.split(home).join('~');
  }
  out = out.replace(/(\/Users\/|\/home\/|C:\\Users\\)[A-Za-z0-9._-]+/g, '$1[USER]');
  return out;
}

function scrubObject(obj, depth = 0) {
  if (depth > 8 || obj == null) return obj;
  if (typeof obj === 'string') return scrubDiagnosticText(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.slice(0, 100).map((x) => scrubObject(x, depth + 1));
  if (typeof obj === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/key|token|secret|password|auth|cookie/i.test(k)) {
        res[k] = v ? '[REDACTED]' : '';
      } else {
        res[k] = scrubObject(v, depth + 1);
      }
    }
    return res;
  }
  return String(obj);
}

function generateDiagnosticBundle({
  category = 'bug',
  summary = '',
  appVersion = '1.3.0',
  surface = 'emerald-carbon',
  theme = 'dark',
  settings = {},
  recentErrors = [],
  providerSummary = {},
} = {}) {
  const payload = {
    bundleId: 'diag-' + crypto.randomBytes(5).toString('hex'),
    generatedAt: new Date().toISOString(),
    appVersion: String(appVersion || '1.3.0'),
    os: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
    ui: { theme, surface },
    feedback: {
      category: String(category || 'bug'),
      summary: scrubDiagnosticText(summary),
    },
    provider: scrubObject(providerSummary),
    settings: scrubObject(settings),
    recentErrors: (Array.isArray(recentErrors) ? recentErrors : []).slice(-25).map((e) => scrubDiagnosticText(e)),
  };
  return payload;
}

module.exports = {
  scrubDiagnosticText,
  scrubObject,
  generateDiagnosticBundle,
};
