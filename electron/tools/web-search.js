'use strict';
/**
 * Reliable multi-source WebSearch + SSRF-hardened WebFetch.
 * Zero external deps — uses native Node fetch + URL/net IP checks.
 */

const dns = require('dns').promises;
const net = require('net');
const untrusted = require('../untrusted');

function isPrivateIpAddress(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;
  if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  if (s.startsWith('::ffff:')) return isPrivateIpAddress(s.slice(7));
  if (!net.isIPv4(s)) return net.isIPv6(s) ? false : true;
  const parts = s.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
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
  const pol = sandbox && typeof sandbox.load === 'function' ? sandbox.load() : null;
  const allowList = [
    ...((pol && pol.network && pol.network.allowedDomains) || []),
    ...((pol && pol.sandbox && pol.sandbox.network && pol.sandbox.network.allowedDomains) || []),
  ];
  const explicitlyAllowedLocal = allowList.some((d) => String(d || '').toLowerCase() === host);

  if (!explicitlyAllowedLocal) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0') {
      throw new Error(`SSRF blocked local hostname: ${host}`);
    }
    if (net.isIP(host)) {
      if (isPrivateIpAddress(host)) throw new Error(`SSRF blocked private/loopback IP: ${host}`);
    } else {
      try {
        const addrs = await dns.lookup(host, { all: true });
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

async function searchBingRss(query, timeoutMs = 10000) {
  const hits = [];
  const res = await fetch('https://www.bing.com/search?format=rss&q=' + encodeURIComponent(query), {
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

const SEARCH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what',
  'when', 'where', 'which', 'how', 'why', 'are', 'was', 'were', 'has', 'have',
  'had', 'not', 'but', 'can', 'will', 'use', 'using', 'used', 'all', 'any',
]);

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

function unwrapDdgUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  const ud = /[?&]uddg=([^&]+)/.exec(url);
  if (ud) {
    try { url = decodeURIComponent(ud[1]); } catch (_) {}
  }
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

async function searchDuckDuckGoHtml(query, timeoutMs = 10000) {
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

async function searchDuckDuckGoLite(query, timeoutMs = 10000) {
  const hits = [];
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
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
  // Match result links in DDG Lite table
  const linkRe = /<a[^>]*class=["'][^"']*result-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const snipRe = /<td[^>]*class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) && links.length < 10) {
    const url = unwrapDdgUrl(m[1]);
    if (/duckduckgo\.com\/y\.js/i.test(url)) continue;
    links.push({ title: stripTags(m[2]), url });
  }
  const snippets = [];
  while ((m = snipRe.exec(html)) && snippets.length < links.length) {
    snippets.push(stripTags(m[1]));
  }
  links.forEach((l, i) => {
    if (l.url && /^https?:\/\//i.test(l.url)) {
      hits.push({ title: l.title || l.url, url: l.url, snippet: snippets[i] || '', source: 'ddg-lite' });
    }
  });
  return hits;
}

async function searchBraveOrTavily(query, timeoutMs = 10000) {
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

async function searchFallbackJsonApis(query, timeoutMs = 10000) {
  const hits = [];
  const tasks = [
    fetch('https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=4&q=' + encodeURIComponent(query), {
      headers: { 'user-agent': 'AkronCode/1.5' },
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
    fetch('https://hn.algolia.com/api/v1/search?hitsPerPage=4&query=' + encodeURIComponent(query), { signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const h of (j && j.hits) || []) {
          const url = h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : '');
          if (url && h.title) hits.push({ title: h.title, url, snippet: stripTags(h.story_text || h.comment_text || `HN (${h.points || 0} pts)`).slice(0, 220), source: 'hn' });
        }
      }).catch(() => {}),
    fetch('https://en.wikipedia.org/w/api.php?action=query&list=search&utf8=1&format=json&srlimit=4&srsearch=' + encodeURIComponent(query), {
      headers: { 'user-agent': 'AkronCode/1.5 (+https://akronlogic.com)' },
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
    fetch('https://api.github.com/search/repositories?per_page=4&q=' + encodeURIComponent(query), {
      headers: { 'user-agent': 'AkronCode/1.5', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const repo of (j && j.items) || []) {
          if (repo.html_url) hits.push({ title: repo.full_name, url: repo.html_url, snippet: repo.description || `${repo.stargazers_count || 0} stars`, source: 'github' });
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
  try {
    let rawHits = (await searchBraveOrTavily(q)) || [];
    if (!rawHits.length) {
      const [ddgH, ddgL, bing] = await Promise.all([
        searchDuckDuckGoHtml(q).catch(() => []),
        searchDuckDuckGoLite(q).catch(() => []),
        searchBingRss(q).catch(() => []),
      ]);
      rawHits = rankAndFilterHits([...ddgH, ...ddgL, ...bing], q, { minScore: 0.2 });
    }
    if (!rawHits.length) {
      const jsonHits = await searchFallbackJsonApis(q);
      rawHits = rankAndFilterHits(jsonHits, q, { minScore: 0.2 });
      if (!rawHits.length && jsonHits.length) rawHits = jsonHits;
    }
    const filtered = rawHits
      .filter((h) => h && h.url && hostMatchesFilter(h.url, allowed_domains, blocked_domains))
      .slice(0, 8);
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
      await assertPublicFetchTarget(currentUrl, sandbox);
      res = await fetch(currentUrl, {
        redirect: 'manual',
        headers: { 'user-agent': 'AkronCode/1.4 (+https://akronlogic.com)', accept: 'text/html,application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        currentUrl = new URL(loc, currentUrl).toString();
        continue;
      }
      break;
    }
    if (!res) return 'Error fetching URL: empty response';
    if (res.status >= 300 && res.status < 400) return 'Error fetching URL: too many redirects';

    // Cap streamed body at 5 MB to prevent memory blowup
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    let raw = '';
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      const MAX = 5 * 1024 * 1024;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        raw += dec.decode(value, { stream: true });
        if (total >= MAX) { try { reader.cancel(); } catch (_) {} break; }
      }
      raw += dec.decode();
    } else {
      raw = await res.text();
    }

    const ct = res.headers.get('content-type') || '';
    let text = ct.includes('text/html') ? stripTags(raw) : raw;
    if (prompt && text.length > 4000) {
      const words = String(prompt).toLowerCase().split(/\W+/).filter((w) => w.length >= 3).slice(0, 8);
      if (words.length) {
        const sentences = text.split(/(?<=[.!?])\s+|\n+/);
        const hits = sentences.filter((s) => words.some((w) => s.toLowerCase().includes(w)));
        if (hits.length >= 3) text = hits.join(' ').slice(0, 30000);
      }
    }
    return untrusted.wrapUntrusted(truncate(text.slice(0, 30000)), { source: 'WebFetch', url: currentUrl });
  } catch (e) {
    return 'Error fetching URL: ' + (e && e.message ? e.message : String(e));
  }
}

module.exports = {
  webSearch,
  webFetch,
  isPrivateIpAddress,
  assertPublicFetchTarget,
  _internal: { searchDuckDuckGoLite, searchDuckDuckGoHtml, searchFallbackJsonApis, hostMatchesFilter, stripTags, rankAndFilterHits, queryKeywords, scoreHit },
};
