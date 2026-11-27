'use strict';
/**
 * Browser URL Actuation Rules (Allow / Deny list matcher).
 * Deny rules strictly override Allow rules.
 */

function normalizeList(list) {
  if (Array.isArray(list)) return list.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof list === 'string') return list.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function matchPattern(urlStr, pattern) {
  const pat = String(pattern || '').trim().toLowerCase();
  if (!pat) return false;
  let u;
  try {
    u = new URL(String(urlStr || '').trim());
  } catch (_) {
    return String(urlStr || '').toLowerCase().includes(pat);
  }
  const host = u.hostname.toLowerCase();
  const full = `${u.protocol}//${u.host}${u.pathname}`.toLowerCase();

  if (pat === '*') return true;
  if (pat.startsWith('http://') || pat.startsWith('https://')) {
    const cleanPat = pat.replace(/\*+$/, '');
    return full.startsWith(cleanPat);
  }
  if (pat.startsWith('*.')) {
    const apex = pat.slice(2);
    return host === apex || host.endsWith('.' + apex);
  }
  const slashIdx = pat.indexOf('/');
  if (slashIdx > 0) {
    const pHost = pat.slice(0, slashIdx);
    const pPath = pat.slice(slashIdx);
    return (host === pHost || host.endsWith('.' + pHost)) && u.pathname.toLowerCase().startsWith(pPath);
  }
  return host === pat || host.endsWith('.' + pat);
}

function evaluateBrowserUrlRule(url, rules = {}) {
  const allowList = normalizeList(rules.allowList);
  const denyList = normalizeList(rules.denyList);
  const target = String(url || '').trim();
  if (!target) return { allowed: false, matchedBy: 'empty', rule: '' };

  for (const rule of denyList) {
    if (matchPattern(target, rule)) {
      return { allowed: false, matchedBy: 'deny', rule, reason: `Blocked by deny rule "${rule}"` };
    }
  }
  if (allowList.length > 0) {
    for (const rule of allowList) {
      if (matchPattern(target, rule)) {
        return { allowed: true, matchedBy: 'allow', rule, reason: `Allowed by rule "${rule}"` };
      }
    }
    return { allowed: false, matchedBy: 'default-deny', rule: '', reason: 'URL does not match any rule in Allow List' };
  }
  return { allowed: true, matchedBy: 'default-allow', rule: '', reason: 'Allowed' };
}

module.exports = {
  normalizeList,
  matchPattern,
  evaluateBrowserUrlRule,
};
