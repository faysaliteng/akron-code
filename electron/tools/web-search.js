'use strict';
/**
 * Reliable multi-source WebSearch + DNS-rebinding-hardened WebFetch.
 * Zero external deps — uses native Node fetch / http(s) + URL/net IP checks.
 */

const dns = require('dns');
const dnsPromises = dns.promises;
const http = require('http');
const https = require('https');
const net = require('net');
const untrusted = require('../untrusted');

function isPrivateIpAddress(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;
  if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  if (s.startsWith('::ffff:')) {
    const tail = s.slice(7);
    const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
    if (hexPair) {
      const hi = parseInt(hexPair[1], 16);
      const lo = parseInt(hexPair[2], 16);
      const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isPrivateIpAddress(dotted);
    }
    return isPrivateIpAddress(tail);
  }
  if (!net.isIPv4(s)) return net.isIPv6(s) ? false : true;
  const parts = s.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isExplicitlyAllowedLocal(host, sandbox) {
  const pol = sandbox && typeof sandbox.load === 'function' ? sandbox.load() : null;
  const allowList = [
    ...((pol && pol.network && pol.network.allowedDomains) || []),
    ...((pol && pol.sandbox && pol.sandbox.network && pol.sandbox.network.allowedDomains) || []),
  ];
  return allowList.some((d) => String(d || '').toLowerCase() === host);
}

async function assertPublicFetchTarget(urlStr, sandbox) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (_) {
    throw new Error('absolute http(s) URL required');
  }
  if (!/^https?:$/i.test(u.protocol)) throw new Error(`unsupported URL protocol: ${u.protocol}`);

  const hostOk = sandbox && typeof sandbox.isHostAllowed === 'function' ? sandbox.isHostAllowed(urlStr) : true;
  if (hostOk !== true) throw new Error(hostOk.reason || `domain denied: ${u.hostname}`);

  const host = u.hostname.toLowerCase();
  const allowedLocal = isExplicitlyAllowedLocal(host, sandbox);

  if (!allowedLocal) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0') {
      throw new Error(`SSRF blocked local hostname: ${host}`);
    }
    if (net.isIP(host)) {
      if (isPrivateIpAddress(host)) throw new Error(`SSRF blocked private/loopback IP: ${host}`);
    } else {
      try {
        const addrs = await dnsPromises.lookup(host, { all: true });
        for (const a of addrs || []) {
          if (a && a.address && isPrivateIpAddress(a.address)) {
            throw new Error(`SSRF blocked hostname "${host}" resolving to private IP ${a.address}`);
          }
        }
      } catch (e) {
        if (e && /SSRF blocked/.test(e.message)) throw e;
      }
    }
  }
  return u;
}

// Socket-level lookup prevents DNS rebinding between assertPublicFetchTarget() and connect().
function requestWithSafeLookup(urlObj, allowLocal, maxBytes = 5 * 1024 * 1024, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const mod = urlObj.protocol === 'https:' ? https : http;
    const safeLookup = (hostname, opts, cb) => {
      const options = typeof opts === 'function' ? {} : (opts || {});
      const done = typeof opts === 'function' ? opts : cb;
      dns.lookup(hostname, options, (err, address, family) => {
        if (err) return done(err);
        if (!allowLocal) {
          if (Array.isArray(address)) {
            const bad = address.find((a) => a && isPrivateIpAddress(a.address));
            if (bad) return done(new Error(`SSRF blocked resolved private IP ${bad.address}`));
          } else if (isPrivateIpAddress(address)) {
            return done(new Error(`SSRF blocked resolved private IP ${address}`));
          }
        }
        return done(null, address, family);
      });
    };
    const req = mod.request(urlObj, {
      method: 'GET',
      lookup: safeLookup,
      timeout: timeoutMs,
      headers: {
        'user-agent': 'AkronCode/1.6 (+https://akronlogic.com)',
        accept: 'text/html,application/json,text/plain,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, raw: '' });
      }
      const chunks = [];
      let total = 0;
      let truncatedBody = false;
      res.on('data', (chunk) => {
        if (truncatedBody) return;
        total += chunk.length;
        if (total > maxBytes) {
          const keep = maxBytes - (total - chunk.length);
          if (keep > 0) chunks.push(chunk.subarray(0, keep));
          truncatedBody = true;
          try { res.destroy(); } catch (_) {}
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode || 200, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => resolve({ status: res.statusCode || 200, headers: res.headers, raw: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostMatchesFilter(urlStr, allowedDomains = [], blockedDomains = []) {
  let host = '';
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch (_) { return false; }
  const match = (pat) => {
    const p = String(pat || '').toLowerCase().trim().replace(/^\*\.?/, '');
    return p && (host === p || host.endsWith('.' + p));
  };
  if (Array.isArray(blockedDomains) && blockedDomains.length && blockedDomains.some(match)) return false;
  if (Array.isArray(allowedDomains) && allowedDomains.length && !allowedDomains.some(match)) return false;
  return true;
}

const SEARCH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what',
  'when', 'where', 'which', 'how', 'why', 'who', 'are', 'was', 'were', 'has', 'have',
  'had', 'not', 'but', 'can', 'will', 'use', 'using', 'used', 'all', 'any', 'is', 'of', 'in', 'to', 'on', 'a', 'an',
]);

function extractCoreSearchQuery(query) {
  let q = String(query || '').trim().replace(/[?!.]+$/g, '');
  q = q.replace(/^(?:what\s+is(?:\s+the)?|who\s+is|where\s+is|how\s+(?:do\s+i|to)|explain|tell\s+me\s+about|define|find)\s+/i, '').trim();
  return q || String(query || '').trim();
}

function queryKeywords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9._-]+/i)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length >= 2 && !SEARCH_STOP_WORDS.has(t));
}

function scoreHit(hit, keywords) {
  if (!keywords.length) return 1;
  const hay = `${hit.title || ''} ${hit.url || ''} ${hit.snippet || ''}`.toLowerCase();
  let matched = 0;
  for (const kw of keywords) {
    if (hay.includes(kw)) matched++;
  }
  return matched / keywords.length;
}

async function searchBingRss(query, timeoutMs = 3000) {
  const hits = [];
  const res = await fetch('https://www.bing.com/search?format=rss&setlang=en-US&mkt=en-US&q=' + encodeURIComponent(query), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return hits;
  const xml = await res.text();
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && hits.length < 10) {
    const block = m[1];
    const titleM = /<title>([\s\S]*?)<\/title>/i.exec(block);
    const linkM = /<link>([\s\S]*?)<\/link>/i.exec(block);
    const descM = /<description>([\s\S]*?)<\/description>/i.exec(block);
    const url = stripTags((linkM && linkM[1]) || '').trim();
    const title = stripTags((titleM && titleM[1]) || '').trim();
    const snippet = stripTags((descM && descM[1]) || '').slice(0, 260);
    if (url && /^https?:\/\//i.test(url)) {
      hits.push({ title: title || url, url, snippet, source: 'bing-rss' });
    }
  }
  return hits;
}

function unwrapDdgUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  const ud = /[?&]uddg=([^&]+)/.exec(url);
  if (ud) {
    try { url = decodeURIComponent(ud[1]); } catch (_) {}
  }
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

async function searchDuckDuckGoHtml(query, timeoutMs = 2500) {
  const hits = [];
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || res.status === 202) return hits;
  const html = await res.text();
  if (/anomaly-modal|challenge-form|bot detection/i.test(html)) return hits;
  const blockRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>)?/gi;
  let m;
  while ((m = blockRe.exec(html)) && hits.length < 10) {
    const url = unwrapDdgUrl(m[1]);
    if (!url || !/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/i.test(url)) continue;
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3] || '').slice(0, 260);
    if (title) hits.push({ title, url, snippet, source: 'ddg-html' });
  }
  return hits;
}

async function searchDuckDuckGoInstant(query, timeoutMs = 4500) {
  const hits = [];
  const res = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1', {
    headers: { 'user-agent': 'AkronCode/1.6 (+https://akronlogic.com)', accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return hits;
  const j = await res.json().catch(() => null);
  if (!j) return hits;
  if (j.AbstractURL && /^https?:\/\//i.test(j.AbstractURL)) {
    hits.push({
      title: j.Heading || j.AbstractSource || j.AbstractURL,
      url: j.AbstractURL,
      snippet: String(j.AbstractText || '').slice(0, 260),
      source: 'ddg-instant',
    });
  }
  for (const r of (Array.isArray(j.Results) ? j.Results : [])) {
    if (r && r.FirstURL && /^https?:\/\//i.test(r.FirstURL)) {
      hits.push({ title: stripTags(r.Text || r.FirstURL).slice(0, 120), url: r.FirstURL, snippet: stripTags(r.Text || ''), source: 'ddg-instant' });
    }
  }
  const collectTopics = (arr) => {
    for (const t of (Array.isArray(arr) ? arr : [])) {
      if (t && Array.isArray(t.Topics)) collectTopics(t.Topics);
      else if (t && t.FirstURL && /^https?:\/\//i.test(t.FirstURL) && hits.length < 8) {
        hits.push({ title: stripTags(t.Text || t.FirstURL).slice(0, 120), url: t.FirstURL, snippet: stripTags(t.Text || '').slice(0, 220), source: 'ddg-instant' });
      }
    }
  };
  collectTopics(j.RelatedTopics);
  return hits;
}

async function searchBraveOrTavily(query, timeoutMs = 8000) {
  const tavily = process.env.TAVILY_API_KEY;
  if (tavily) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: tavily, query, max_results: 8, include_answer: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) {
      const j = await r.json();
      return (j.results || []).map((x) => ({ title: x.title || x.url, url: x.url, snippet: x.content || '', source: 'tavily' }));
    }
  }
  const brave = process.env.BRAVE_SEARCH_API_KEY;
  if (brave) {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=8&q=' + encodeURIComponent(query), {
      headers: { 'X-Subscription-Token': brave, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) {
      const j = await r.json();
      return ((j.web && j.web.results) || []).map((x) => ({ title: x.title || x.url, url: x.url, snippet: x.description || '', source: 'brave' }));
    }
  }
  const searx = process.env.SEARXNG_URL;
  if (searx) {
    const r = await fetch(searx.replace(/\/$/, '') + '/search?format=json&q=' + encodeURIComponent(query), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) {
      const j = await r.json();
      return (j.results || []).slice(0, 8).map((x) => ({ title: x.title || x.url, url: x.url, snippet: x.content || '', source: 'searxng' }));
    }
  }
  return null;
}

async function searchStructuredPublicApis(query, coreQuery, timeoutMs = 6000) {
  const hits = [];
  const q = coreQuery || query;
  const tasks = [
    searchDuckDuckGoInstant(q, timeoutMs).then((list) => hits.push(...list)).catch(() => {}),
    fetch('https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&format=json&search=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'AkronCode/1.6 (+https://akronlogic.com)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((arr) => {
        const titles = Array.isArray(arr && arr[1]) ? arr[1] : [];
        const descs = Array.isArray(arr && arr[2]) ? arr[2] : [];
        const urls = Array.isArray(arr && arr[3]) ? arr[3] : [];
        titles.forEach((t, i) => {
          if (urls[i]) hits.push({ title: t, url: urls[i], snippet: String(descs[i] || '').slice(0, 220), source: 'wikipedia-open' });
        });
      }).catch(() => {}),
    fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=4&srsearch=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'AkronCode/1.6 (+https://akronlogic.com)' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const item of ((j && j.query && j.query.search) || [])) {
          if (item && item.title) {
            const url = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(item.title).replace(/\s+/g, '_'));
            hits.push({ title: item.title, url, snippet: stripTags(item.snippet || '').slice(0, 220), source: 'wikipedia' });
          }
        }
      }).catch(() => {}),
    fetch('https://developer.mozilla.org/api/v1/search?q=' + encodeURIComponent(q) + '&locale=en-US', {
      headers: { 'user-agent': 'AkronCode/1.6 (+https://akronlogic.com)', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const doc of ((j && j.documents) || []).slice(0, 4)) {
          if (doc && doc.mdn_url && doc.title) {
            hits.push({
              title: `${doc.title} — MDN`,
              url: 'https://developer.mozilla.org' + doc.mdn_url,
              snippet: stripTags(doc.summary || '').slice(0, 240),
              source: 'mdn',
            });
          }
        }
      }).catch(() => {}),
    fetch('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=4&q=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'AkronCode/1.6' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const item of (j && j.items) || []) {
          if (item && item.link && item.title) {
            hits.push({ title: stripTags(item.title), url: item.link, snippet: `StackOverflow (score ${item.score || 0}, answers ${item.answer_count || 0})`, source: 'stackoverflow' });
          }
        }
      }).catch(() => {}),
    fetch('https://hn.algolia.com/api/v1/search?hitsPerPage=4&query=' + encodeURIComponent(q), { signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const h of (j && j.hits) || []) {
          const url = h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : '');
          if (url && h.title) hits.push({ title: h.title, url, snippet: stripTags(h.story_text || h.comment_text || `HN (${h.points || 0} pts)`).slice(0, 220), source: 'hn' });
        }
      }).catch(() => {}),
    fetch('https://api.github.com/search/repositories?per_page=4&q=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'AkronCode/1.6', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const repo of (j && j.items) || []) {
          if (repo.html_url) hits.push({ title: repo.full_name, url: repo.html_url, snippet: repo.description || `${repo.stargazers_count || 0} stars`, source: 'github' });
        }
      }).catch(() => {}),
    fetch('https://registry.npmjs.org/-/v1/search?size=4&text=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'AkronCode/1.6', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const obj of (j && j.objects) || []) {
          const pkg = obj && obj.package;
          if (pkg && pkg.name) {
            hits.push({
              title: `npm: ${pkg.name}`,
              url: (pkg.links && (pkg.links.npm || pkg.links.homepage || pkg.links.repository)) || ('https://www.npmjs.com/package/' + encodeURIComponent(pkg.name)),
              snippet: stripTags(pkg.description || '').slice(0, 220),
              source: 'npm',
            });
          }
        }
      }).catch(() => {}),
  ];
  await Promise.all(tasks);
  return hits;
}

function rankAndFilterHits(hits, query, { minScore = 0.25 } = {}) {
  const kws = queryKeywords(query);
  const seen = new Set();
  const scored = [];
  for (const h of hits || []) {
    if (!h || !h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    const s = scoreHit(h, kws);
    if (kws.length > 0 && s < minScore && h.source !== 'tavily' && h.source !== 'brave' && h.source !== 'searxng') {
      continue;
    }
    scored.push({ ...h, _score: s });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored;
}

async function webSearch({ query, allowed_domains, blocked_domains } = {}) {
  const q = String(query || '').trim();
  if (!q) return 'Error: query required';
  const coreQ = extractCoreSearchQuery(q);
  try {
    const applyDomain = (arr) => (arr || []).filter((h) => h && h.url && hostMatchesFilter(h.url, allowed_domains, blocked_domains));
    let filtered = applyDomain((await searchBraveOrTavily(q)) || []);
    if (!filtered.length) {
      const [ddgH, bing, pubHits] = await Promise.all([
        searchDuckDuckGoHtml(q).catch(() => []),
        searchBingRss(q).catch(() => []),
        searchStructuredPublicApis(q, coreQ).catch(() => []),
      ]);
      // Fix N18: apply domain filters BEFORE ranking/truncating so allowed_domains never gets starved.
      const domainSafe = applyDomain([...ddgH, ...bing, ...pubHits]);
      const kws = queryKeywords(coreQ);
      const minScore = kws.length >= 2 ? 0.34 : 0.25;
      filtered = rankAndFilterHits(domainSafe, coreQ, { minScore });
    }
    filtered = filtered.slice(0, 8);
    if (!filtered.length) return '(no results)';
    const text = filtered
      .map((h, i) => `${i + 1}. ${h.title}\n   URL: ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
      .join('\n\n');
    return untrusted.wrapUntrusted(text, { source: 'WebSearch', url: q });
  } catch (e) {
    return 'Error searching: ' + (e && e.message ? e.message : String(e));
  }
}

async function webFetch({ url, prompt, sandbox, truncate = (s) => s } = {}) {
  if (!url) return 'Error: absolute http(s) URL required';
  try {
    let currentUrl = String(url).trim();
    let res = null;
    for (let hop = 0; hop < 6; hop++) {
      const uObj = await assertPublicFetchTarget(currentUrl, sandbox);
      const allowLocal = isExplicitlyAllowedLocal(uObj.hostname.toLowerCase(), sandbox);
      res = await requestWithSafeLookup(uObj, allowLocal);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && (res.headers.location || res.headers.Location);
        if (!loc) break;
        currentUrl = new URL(Array.isArray(loc) ? loc[0] : loc, currentUrl).toString();
        continue;
      }
      break;
    }
    if (!res) return 'Error fetching URL: empty response';
    if (res.status >= 300 && res.status < 400) return 'Error fetching URL: too many redirects';

    const ct = String((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
    const raw = res.raw || '';
    let text = ct.includes('text/html') ? stripTags(raw) : raw;
    if (prompt && text.length > 4000) {
      const words = String(prompt).toLowerCase().split(/\W+/).filter((w) => w.length >= 3).slice(0, 8);
      if (words.length) {
        const idx = text.toLowerCase().split(/\n+/).filter((l) => words.some((w) => l.toLowerCase().includes(w))).join('\n');
        if (idx) text = idx + '\n---\n' + text.slice(0, 4000);
      }
    }
    return untrusted.wrapUntrusted(truncate(`URL: ${currentUrl} (HTTP ${res.status})\n\n${text}`), { source: 'WebFetch', url: currentUrl });
  } catch (e) {
    return 'Error fetching URL: ' + (e && e.message ? e.message : String(e));
  }
}

module.exports = {
  isPrivateIpAddress,
  assertPublicFetchTarget,
  extractCoreSearchQuery,
  rankAndFilterHits,
  webSearch,
  webFetch,
  _internal: {
    isPrivateIpAddress,
    assertPublicFetchTarget,
    hostMatchesFilter,
    queryKeywords,
    scoreHit,
    rankAndFilterHits,
    stripTags,
  },
};
