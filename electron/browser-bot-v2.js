'use strict';
/**
 * Akron Browser Bot 2.0 Core Helpers:
 *  - Compact Accessibility-Tree Snapshots (@e1, @e2...) with semantic fingerprints
 *  - Set-of-Marks (SoM) canvas/SVG visual badge fallback
 *  - Zero-exposure Secret Vault autofill + RFC 6238 TOTP generator
 *  - CAPTCHA / 2FA / Checkout Human Handoff detection & pause/resume
 */
const crypto = require('crypto');
const secretstore = require('./secretstore');

// ---------- 1. Compact AX Snapshots (@e12 refs) ----------

function normalizeRefId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.startsWith('@') ? s.slice(1) : s;
}

function buildCompactAxSnapshot(nodes = [], meta = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const refs = [];
  const refMap = Object.create(null);
  const lines = [];
  if (meta.title || meta.url) {
    lines.push(`PAGE: ${String(meta.title || '(untitled)')} (${String(meta.url || '')})`);
  }

  let idx = 1;
  for (const n of list) {
    if (!n || typeof n !== 'object') continue;
    const role = String(n.role || n.tag || 'control').toLowerCase();
    const name = String(n.name || n.label || n.ariaLabel || n.placeholder || n.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const interactive = n.interactive !== false;
    if (!interactive && !name) continue;

    const bareId = `e${idx++}`;
    const refId = `@${bareId}`;
    const fp = {
      ref: refId,
      bareRef: bareId,
      role,
      tag: String(n.tag || '').toLowerCase(),
      name,
      id: n.id ? String(n.id) : '',
      testId: n.testId ? String(n.testId) : '',
      ariaLabel: n.ariaLabel ? String(n.ariaLabel) : '',
      placeholder: n.placeholder ? String(n.placeholder) : '',
      nameAttr: n.nameAttr ? String(n.nameAttr) : '',
      href: n.href ? String(n.href) : '',
      type: n.type ? String(n.type).toLowerCase() : '',
      value: n.value != null ? String(n.value).slice(0, 60) : '',
      checked: typeof n.checked === 'boolean' ? n.checked : undefined,
      disabled: !!n.disabled,
      selector: n.selector ? String(n.selector) : '',
      bbox: n.bbox && typeof n.bbox === 'object'
        ? {
            x: Math.round(Number(n.bbox.x) || 0),
            y: Math.round(Number(n.bbox.y) || 0),
            w: Math.round(Number(n.bbox.w || n.bbox.width) || 0),
            h: Math.round(Number(n.bbox.h || n.bbox.height) || 0),
          }
        : null,
    };
    refs.push(fp);
    refMap[refId] = fp;
    refMap[bareId] = fp;

    const attrs = [];
    if (fp.type && fp.type !== role) attrs.push(`type=${fp.type}`);
    if (fp.value && fp.type !== 'password') attrs.push(`val=${JSON.stringify(fp.value)}`);
    if (fp.type === 'password' && fp.value) attrs.push('val="[redacted]"');
    if (typeof fp.checked === 'boolean') attrs.push(fp.checked ? 'checked' : 'unchecked');
    if (fp.disabled) attrs.push('disabled');
    if (fp.href) attrs.push(`href=${fp.href.slice(0, 80)}`);

    lines.push(`${refId} [${role}]${name ? ' ' + JSON.stringify(name) : ''}${attrs.length ? ' (' + attrs.join(', ') + ')' : ''}`);
  }

  return {
    ok: true,
    url: String(meta.url || ''),
    title: String(meta.title || ''),
    count: refs.length,
    sparseAx: refs.length < 3,
    refs,
    refMap,
    snapshotText: lines.join('\n'),
  };
}

function buildAxCollectScript(options = {}) {
  const maxItems = Math.min(Math.max(Number(options.maxItems) || 120, 10), 300);
  const includeText = options.includeText !== false;
  return `(function () {
    const MAX = ${maxItems};
    const isVis = (el) => {
      if (!el || !el.isConnected) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    const buildSel = (el) => {
      if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid').replace(/"/g, '\\\\"') + '"]';
      if (el.id) return '#' + esc(el.id);
      if (el.name) return el.tagName.toLowerCase() + '[name="' + String(el.name).replace(/"/g, '\\\\"') + '"]';
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 4) {
        let p = cur.tagName.toLowerCase();
        if (cur.id) { parts.unshift('#' + esc(cur.id)); break; }
        const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(c => c.tagName === cur.tagName) : [];
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
        parts.unshift(p);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };
    const candidates = Array.from(document.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), canvas, svg[role], [contenteditable="true"]'
    )).filter(isVis).slice(0, MAX);

    const nodes = candidates.map((el, i) => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role')
        || (tag === 'a' ? 'link'
          : tag === 'button' ? 'button'
          : tag === 'select' ? 'combobox'
          : tag === 'textarea' ? 'textbox'
          : tag === 'canvas' ? 'canvas'
          : tag === 'input' ? (el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'textbox'))
          : 'control');
      const r = el.getBoundingClientRect();
      let labelText = el.getAttribute('aria-label') || '';
      if (!labelText && el.id) {
        const lbl = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
        if (lbl) labelText = lbl.innerText || '';
      }
      const text = (labelText || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim();
      const refTag = '@e' + (i + 1);
      try { el.setAttribute('data-akron-ref', refTag); } catch (_) {}
      return {
        role,
        tag,
        name: text.slice(0, 90),
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        id: el.id || '',
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || '',
        nameAttr: el.getAttribute('name') || '',
        href: el.getAttribute('href') || '',
        type: (el.getAttribute('type') || '').toLowerCase(),
        value: el.value != null ? String(el.value).slice(0, 60) : '',
        checked: (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : undefined,
        disabled: !!el.disabled,
        interactive: true,
        selector: '[data-akron-ref="' + refTag + '"]',
        fallbackSelector: buildSel(el),
        bbox: { x: r.left, y: r.top, w: r.width, h: r.height },
      };
    });
    return {
      title: document.title || '',
      url: location.href || '',
      textSummary: ${includeText ? '(document.body ? document.body.innerText : "").slice(0, 4000)' : '""'},
      nodes,
    };
  })()`;
}

// ---------- 2. Set-of-Marks Visual Fallback ----------

function buildSomOverlayScript(action = 'show') {
  if (action === 'clear') {
    return `(function () {
      const el = document.getElementById('__akron_som_layer__');
      if (el) el.remove();
      return { ok: true, cleared: true };
    })()`;
  }
  return `(function () {
    const old = document.getElementById('__akron_som_layer__');
    if (old) old.remove();
    const layer = document.createElement('div');
    layer.id = '__akron_som_layer__';
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    const targets = Array.from(document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role="button"], canvas, [tabindex]:not([tabindex="-1"])'));
    const marks = [];
    let idx = 1;
    for (const el of targets) {
      if (marks.length >= 80) break;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) continue;
      const ref = '@e' + idx++;
      try { el.setAttribute('data-akron-ref', ref); } catch (_) {}
      const badge = document.createElement('div');
      badge.textContent = ref;
      badge.style.cssText = 'position:fixed;left:' + Math.max(2, Math.round(r.left)) + 'px;top:' + Math.max(2, Math.round(r.top)) + 'px;background:#0f766e;color:#ecfdf5;font:700 10px/1.1 ui-monospace,monospace;padding:2px 4px;border-radius:4px;border:1px solid #34d399;box-shadow:0 2px 6px rgba(0,0,0,.45);';
      layer.appendChild(badge);
      marks.push({ ref, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), width: Math.round(r.width), height: Math.round(r.height), tag: el.tagName.toLowerCase() });
    }
    document.documentElement.appendChild(layer);
    return { ok: true, count: marks.length, marks };
  })()`;
}

// ---------- 3. RFC 6238 TOTP + Zero-Exposure Secret Vault Autofill ----------

const BASE32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHA.indexOf(clean[i]);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function parseTotpUri(raw) {
  const s = String(raw || '').trim();
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return {
        secret: u.searchParams.get('secret') || '',
        digits: Number(u.searchParams.get('digits')) || 6,
        period: Number(u.searchParams.get('period')) || 30,
        algorithm: (u.searchParams.get('algorithm') || 'sha1').toLowerCase(),
      };
    } catch (_) {}
  }
  return { secret: s, digits: 6, period: 30, algorithm: 'sha1' };
}

function computeTotp(secretOrUri, opts = {}) {
  const parsed = parseTotpUri(secretOrUri);
  const key = decodeBase32(parsed.secret);
  if (!key.length) throw new Error('Invalid Base32 TOTP secret');
  const digits = Math.min(8, Math.max(6, Number(opts.digits || parsed.digits) || 6));
  const period = Math.max(5, Number(opts.period || parsed.period) || 30);
  const algo = ['sha1', 'sha256', 'sha512'].includes(String(opts.algorithm || parsed.algorithm).toLowerCase())
    ? String(opts.algorithm || parsed.algorithm).toLowerCase()
    : 'sha1';
  const nowSec = Math.floor((opts.nowMs != null ? Number(opts.nowMs) : Date.now()) / 1000);
  const counter = Math.floor(nowSec / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % Math.pow(10, digits);
  return {
    code: String(codeInt).padStart(digits, '0'),
    digits,
    period,
    remainingSec: period - (nowSec % period),
  };
}

function normalizeOrigin(urlOrOrigin) {
  try {
    const u = new URL(String(urlOrOrigin || ''));
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch (_) {
    return String(urlOrOrigin || '').trim().toLowerCase();
  }
}

function isOriginAllowedForVault(pageUrl, expectedOrigin) {
  const pageOrig = normalizeOrigin(pageUrl);
  const expOrig = normalizeOrigin(expectedOrigin);
  if (!pageOrig || !expOrig) return false;
  return pageOrig === expOrig;
}

function setVaultCredential({ origin, username = '', password = '', totpSecret = '', store = secretstore } = {}) {
  const orig = normalizeOrigin(origin);
  if (!orig) throw new Error('Valid origin URL required');
  if (username) store.set(`vault:${orig}:username`, String(username));
  if (password) store.set(`vault:${orig}:password`, String(password));
  if (totpSecret) store.set(`vault:${orig}:totp`, String(totpSecret));
  return { ok: true, origin: orig, hasUsername: !!username, hasPassword: !!password, hasTotp: !!totpSecret };
}

/**
 * Resolve & inject vault credentials into the active page WITHOUT returning
 * plaintext secret values to the model.
 */
async function vaultAutofill({
  pageUrl,
  expectedOrigin,
  selectors = {},
  injectFn,
  store = secretstore,
  nowMs,
} = {}) {
  const orig = normalizeOrigin(expectedOrigin || pageUrl);
  if (!orig) return { ok: false, error: 'Origin required for vault autofill' };
  if (pageUrl && !isOriginAllowedForVault(pageUrl, orig)) {
    return {
      ok: false,
      blocked: true,
      error: `Origin mismatch: page is "${normalizeOrigin(pageUrl)}", credential is scoped strictly to "${orig}"`,
    };
  }
  const username = store.get(`vault:${orig}:username`);
  const password = store.get(`vault:${orig}:password`);
  const totpRaw = store.get(`vault:${orig}:totp`);
  if (!username && !password && !totpRaw) {
    return { ok: false, origin: orig, error: `No vault credentials saved for ${orig}` };
  }

  let totpCode = null;
  if (totpRaw) {
    try { totpCode = computeTotp(totpRaw, { nowMs }).code; } catch (_) {}
  }

  const filledFields = [];
  if (typeof injectFn === 'function') {
    const assignments = [];
    if (username && (selectors.username || 'input[type="email"], input[name*="user" i], input[name*="email" i], input[autocomplete="username"]')) {
      assignments.push({ field: 'username', selector: selectors.username || 'input[type="email"], input[name*="user" i], input[name*="email" i], input[autocomplete="username"]', value: username });
    }
    if (password) {
      assignments.push({ field: 'password', selector: selectors.password || 'input[type="password"], input[autocomplete="current-password"]', value: password });
    }
    if (totpCode && (selectors.totp || 'input[name*="otp" i], input[name*="totp" i], input[name*="code" i], input[autocomplete="one-time-code"]')) {
      assignments.push({ field: 'totp', selector: selectors.totp || 'input[name*="otp" i], input[name*="totp" i], input[name*="code" i], input[autocomplete="one-time-code"]', value: totpCode });
    }
    const res = await injectFn(assignments);
    const applied = Array.isArray(res && res.applied) ? res.applied : assignments.map((a) => a.field);
    filledFields.push(...applied);
  } else {
    if (username) filledFields.push('username');
    if (password) filledFields.push('password');
    if (totpCode) filledFields.push('totp');
  }

  return {
    ok: filledFields.length > 0,
    origin: orig,
    filledFields,
    totpApplied: filledFields.includes('totp'),
    masked: true,
    // Security invariant: never expose plaintext credential material in return payload.
  };
}

// ---------- 4. Human Handoff Pause / Resume (CAPTCHA / 2FA / Checkout) ----------

const pendingHandoffs = new Map();

function detectHumanGate({ url = '', title = '', text = '', selectors = [] } = {}) {
  const hay = `${url}\n${title}\n${text}\n${(Array.isArray(selectors) ? selectors : []).join(' ')}`.toLowerCase();
  if (/recaptcha|hcaptcha|cf-turnstile|g-recaptcha|verify you are human|are you a robot|arkoselabs/.test(hay)) {
    return { gated: true, gateType: 'captcha', reason: 'CAPTCHA or anti-bot challenge detected; human completion required.' };
  }
  if (/two-factor|2fa verification|authenticator app|enter verification code|one-time passcode|sms verification/.test(hay)) {
    return { gated: true, gateType: '2fa', reason: '2FA/OTP authentication prompt detected; waiting for human confirmation.' };
  }
  if (/\/checkout\b|place your order|confirm payment|credit card number|cardnumber|cvc|stripe-card/.test(hay)) {
    return { gated: true, gateType: 'checkout', reason: 'Payment / final checkout confirmation detected; pausing for human review.' };
  }
  return { gated: false, gateType: null, reason: '' };
}

function requestHumanHandoff({ pauseId, gateType = 'manual', reason = 'Waiting for human intervention', url = '', signal } = {}) {
  const id = String(pauseId || `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  return new Promise((resolve) => {
    const entry = {
      id,
      gateType,
      reason,
      url,
      createdAt: Date.now(),
      resolve: (outcome) => {
        pendingHandoffs.delete(id);
        resolve(outcome);
      },
    };
    pendingHandoffs.set(id, entry);
    if (signal) {
      if (signal.aborted) {
        entry.resolve({ ok: false, resumed: false, action: 'aborted' });
        return;
      }
      signal.addEventListener('abort', () => entry.resolve({ ok: false, resumed: false, action: 'aborted' }), { once: true });
    }
  });
}

function resumeHumanGate(pauseId, action = 'continue') {
  const entry = pendingHandoffs.get(String(pauseId || ''));
  if (!entry) return { ok: false, error: 'No pending human handoff with that id' };
  const ok = action !== 'cancel' && action !== 'abort';
  entry.resolve({ ok, resumed: ok, action: String(action || 'continue'), pauseId: entry.id });
  return { ok: true, pauseId: entry.id, action: String(action || 'continue') };
}

function listPendingHandoffs() {
  return [...pendingHandoffs.values()].map((h) => ({
    id: h.id,
    gateType: h.gateType,
    reason: h.reason,
    url: h.url,
    createdAt: h.createdAt,
  }));
}

module.exports = {
  normalizeRefId,
  buildCompactAxSnapshot,
  buildAxCollectScript,
  buildSomOverlayScript,
  decodeBase32,
  parseTotpUri,
  computeTotp,
  normalizeOrigin,
  isOriginAllowedForVault,
  setVaultCredential,
  vaultAutofill,
  detectHumanGate,
  requestHumanHandoff,
  resumeHumanGate,
  listPendingHandoffs,
};
