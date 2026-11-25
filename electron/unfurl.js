'use strict';
// Link unfurl — the Desktop `og` / `twitter` / `xlink` feature set.
//
// Desktop's renderer reads <meta property="og:*"> and <meta name="twitter:*">
// off a fetched document and paints a preview card in the transcript
// (`og:title`, `og:description`, `og:image`, `twitter:card`, `twitter:title`,
// `twitter:description`, `twitter:image`, and the SVG `xlink:href` /
// `xlink:title` used for the card icon). Akron Bot implements the same
// capability in the main process: fetch the head, extract OpenGraph + Twitter
// Card metadata (falling back to <title> / <meta name=description> / favicon),
// cache it, and hand it to the renderer for a card.
//
// Security: the renderer asks us to fetch arbitrary URLs, so this module is an
// SSRF surface. Every hop is resolved with dns.lookup and the connection is
// pinned to the resolved IP (Host + SNI preserved), so DNS rebinding cannot
// swap a public name for an internal address after the check. Loopback,
// private, link-local, CGNAT, multicast and metadata addresses are refused.
//
// Pure Node — no Electron — so it is testable headless.

const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MAX_BYTES = 320 * 1024; // read the head, not the site
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AkronBot/1.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// HTML entity decoding (just the set that shows up in meta content)
// ---------------------------------------------------------------------------
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019',
  lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', laquo: '\u00ab',
  raquo: '\u00bb', deg: '\u00b0', times: '\u00d7', bull: '\u2022',
};

function decodeEntities(input) {
  if (!input) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&([a-z]+);/gi, (m, name) => (NAMED[name.toLowerCase()] !== undefined ? NAMED[name.toLowerCase()] : m));
}

function collapse(text) {
  return decodeEntities(text).replace(/[\s\u00a0]+/g, ' ').trim();
}

function clip(text, max) {
  const t = collapse(text);
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '\u2026' : t;
}

// ---------------------------------------------------------------------------
// <meta> parsing
// ---------------------------------------------------------------------------
// Accepts any attribute order and quote style. Returns [{key, content}].
const META_RE = /<meta\b([^>]*)>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseTagAttributes(raw) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) {
    const key = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (out[key] === undefined) out[key] = value;
  }
  return out;
}

function parseMetaTags(html) {
  const metas = [];
  const chunk = String(html || '').slice(0, MAX_BYTES);
  let m;
  META_RE.lastIndex = 0;
  while ((m = META_RE.exec(chunk))) {
    const attrs = parseTagAttributes(m[1]);
    const key = attrs.property || attrs.name || attrs.itemprop || '';
    if (!key || attrs.content === undefined) continue;
    metas.push({ key: String(key).toLowerCase().trim(), content: attrs.content });
  }
  return metas;
}

function firstMeta(metas, keys) {
  for (const key of keys) {
    const hit = metas.find((m) => m.key === key && collapse(m.content));
    if (hit) return collapse(hit.content);
  }
  return '';
}

function titleTag(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || '').slice(0, MAX_BYTES));
  return m ? collapse(m[1]) : '';
}

function linkHref(html, rels) {
  const re = /<link\b([^>]*)>/gi;
  let m;
  const chunk = String(html || '').slice(0, MAX_BYTES);
  while ((m = re.exec(chunk))) {
    const attrs = parseTagAttributes(m[1]);
    const rel = String(attrs.rel || '').toLowerCase();
    if (!attrs.href) continue;
    if (rels.some((r) => rel.split(/\s+/).includes(r))) return attrs.href;
  }
  return '';
}

function absolute(candidate, baseUrl) {
  if (!candidate) return '';
  const raw = String(candidate).trim();
  if (!raw || /^data:/i.test(raw)) return '';
  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------
function extractMeta(html, pageUrl) {
  const metas = parseMetaTags(html);
  const og = (name) => firstMeta(metas, ['og:' + name]);
  const tw = (name) => firstMeta(metas, ['twitter:' + name]);

  const title = clip(og('title') || tw('title') || titleTag(html) || '', 200);
  const description = clip(
    og('description') || tw('description') || firstMeta(metas, ['description']) || '',
    400,
  );
  const imageSrc = og('image:url') || og('image') || tw('image:src') || tw('image') || '';
  const image = absolute(imageSrc, pageUrl);
  const siteName = clip(og('site_name') || tw('site') || '', 80);
  const card = (tw('card') || (og('type') ? 'summary_large_image' : 'summary')).toLowerCase();
  const icon = absolute(linkHref(html, ['icon', 'shortcut', 'apple-touch-icon']), pageUrl);

  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_) {}

  return {
    ok: true,
    url: pageUrl,
    title: title || host,
    description,
    image,
    icon,
    siteName: siteName || host,
    card: card === 'player' || card === 'summary' ? card : 'summary_large_image',
    type: clip(og('type') || '', 40),
  };
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------
function normalizeIp(ip) {
  return String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

function isBlockedIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (ip.includes(':')) {
    // IPv6: loopback, unspecified, unique-local, link-local, mapped v4
    if (ip === '::1' || ip === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;   // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;   // fe80::/10
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isBlockedIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) return true;
    return false;
  }
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return BLOCKED_V4.some(({ base, mask }) => (n & mask) === (base & mask));
}

function blockedHostname(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  if (/\.(local|internal|localdomain|lan|home|corp)$/.test(h)) return true;
  return false;
}

function parseTarget(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '').trim()); } catch (_) { return { ok: false, message: 'Not a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: 'Only http and https links can be previewed.' };
  }
  if (u.username || u.password) return { ok: false, message: 'Links with credentials are not previewed.' };
  if (blockedHostname(u.hostname)) return { ok: false, message: 'That host cannot be previewed.' };
  // Literal IPs are checked here too, so a redirect or a link in a message can
  // never reach an internal address even before DNS is consulted.
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) {
    if (isBlockedIp(u.hostname)) return { ok: false, message: 'That host points at a private address and is not previewed.' };
  }
  return { ok: true, url: u };
}

function lookup(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, list) => {
      if (err || !list || !list.length) return resolve({ ok: false, message: 'Host could not be resolved.' });
      resolve({ ok: true, list });
    });
  });
}

// ---------------------------------------------------------------------------
// Fetch (pinned to the resolved address)
// ---------------------------------------------------------------------------
function requestOnce({ url, address, headers, timeoutMs }) {
  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const opts = {
      host: address,
      family: address.includes(':') ? 6 : 4,
      port: url.port || (isHttps ? 443 : 80),
      path: (url.pathname || '/') + (url.search || ''),
      method: 'GET',
      headers: { ...headers, host: url.hostname + (url.port ? ':' + url.port : '') },
      timeout: timeoutMs,
    };
    if (isHttps) opts.servername = url.hostname;

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { req.destroy(); } catch (_) {} resolve(v); } };

    const req = mod.request(opts, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return finish({ ok: true, redirect: res.headers.location, status });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      if (!/text\/html|application\/xhtml|text\/plain|application\/xml/.test(type) && type) {
        res.resume();
        return finish({ ok: false, status, message: 'That link is not an HTML page.' });
      }

      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('error', () => finish({ ok: false, status, message: 'Could not read that page.' }));

      const chunks = [];
      let size = 0;
      stream.on('data', (buf) => {
        size += buf.length;
        chunks.push(buf);
        if (size >= MAX_BYTES) finish({ ok: true, status, body: Buffer.concat(chunks).toString('utf8'), truncated: true });
      });
      stream.on('end', () => finish({ ok: true, status, body: Buffer.concat(chunks).toString('utf8') }));
    });

    req.on('timeout', () => finish({ ok: false, message: 'That link took too long to answer.' }));
    req.on('error', () => finish({ ok: false, message: 'That link could not be reached.' }));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
function cacheFile(dataDir) {
  return path.join(dataDir || path.join(os.homedir(), '.autobot'), 'unfurl-cache.json');
}

function readCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && raw.entries ? raw : { entries: {} };
  } catch (_) {
    return { entries: {} };
  }
}

function writeCache(file, cache) {
  try {
    const entries = cache.entries || {};
    const keys = Object.keys(entries);
    if (keys.length > CACHE_MAX) {
      keys.sort((a, b) => (entries[a].at || 0) - (entries[b].at || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete entries[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 0));
  } catch (_) { /* cache is best-effort */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function unfurl(rawUrl, opts = {}) {
  const target = parseTarget(rawUrl);
  if (!target.ok) return { ok: false, url: String(rawUrl || ''), message: target.message };

  const file = cacheFile(opts.dataDir);
  const key = target.url.toString();
  if (opts.useCache !== false) {
    const cache = readCache(file);
    const hit = cache.entries[key];
    if (hit && Date.now() - (hit.at || 0) < CACHE_TTL_MS && hit.data) return { ...hit.data, cached: true };
  }

  let url = target.url;
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
  };

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guarded = parseTarget(url.toString());
    if (!guarded.ok) return { ok: false, url: key, message: guarded.message };

    const looked = await lookup(url.hostname);
    if (!looked.ok) return { ok: false, url: key, message: looked.message };
    if (looked.list.some((e) => isBlockedIp(e.address))) {
      return { ok: false, url: key, message: 'That host points at a private address and is not previewed.' };
    }

    const res = await requestOnce({
      url,
      address: looked.list[0].address,
      headers,
      timeoutMs: opts.timeoutMs || TIMEOUT_MS,
    });

    if (res.redirect) {
      try { url = new URL(res.redirect, url); } catch (_) { return { ok: false, url: key, message: 'That link redirects somewhere invalid.' }; }
      continue;
    }
    if (!res.ok) return { ok: false, url: key, status: res.status, message: res.message || 'That link could not be previewed.' };

    const meta = extractMeta(res.body || '', url.toString());
    const result = { ...meta, resolvedUrl: url.toString(), fetchedAt: Date.now() };
    if (opts.useCache !== false) {
      const cache = readCache(file);
      cache.entries[key] = { at: Date.now(), data: result };
      writeCache(file, cache);
    }
    return result;
  }
  return { ok: false, url: key, message: 'That link redirects too many times.' };
}

async function unfurlMany(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : []).map((u) => String(u || '').trim()).filter(Boolean).slice(0, opts.limit || 8);
  const seen = new Set();
  const unique = [];
  for (const u of list) {
    const key = u.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(u);
  }
  const results = await Promise.all(unique.map((u) => unfurl(u, opts).catch(() => ({ ok: false, url: u, message: 'Preview failed.' }))));
  return results;
}

// A link is worth unfurling if it is a bare http(s) URL that is not an image,
// a media file, or obviously local.
const SKIP_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mov|m4v|mp3|wav|ogg|flac|pdf|zip|tar|gz|dmg|exe|bin|iso)(\?|#|$)/i;

function looksUnfurlable(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  if (SKIP_RE.test(s)) return false;
  const target = parseTarget(s);
  return target.ok;
}

module.exports = {
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  CACHE_TTL_MS,
  decodeEntities,
  parseMetaTags,
  extractMeta,
  ipv4ToInt,
  isBlockedIp,
  blockedHostname,
  parseTarget,
  looksUnfurlable,
  unfurl,
  unfurlMany,
  cacheFile,
  readCache,
  writeCache,
};
