'use strict';
// Link unfurl: OpenGraph / Twitter Card / fallback metadata extraction, the
// SSRF guard, the redirect chain, the cache, and looksUnfurlable.
// The network is never touched: requestOnce is exercised through a local HTTP
// server (which must be REFUSED by the guard) and the parser is exercised with
// fixtures.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const u = require('../electron/unfurl');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nunfurl — entity decoding');
  // -------------------------------------------------------------------------
  eq('named entities', u.decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
  eq('numeric entities', u.decodeEntities('&#65;&#x42;&#x1F600;'), 'AB\u{1F600}');
  eq('unknown entity left alone', u.decodeEntities('&notreal;'), '&notreal;');
  eq('non-breaking space collapses', u.decodeEntities('a&nbsp;&nbsp;b'), 'a  b');

  // -------------------------------------------------------------------------
  console.log('\nunfurl — meta tag parsing');
  // -------------------------------------------------------------------------
  const metas = u.parseMetaTags(`
    <meta property="og:title" content="OG Title">
    <meta content="reversed order" property="og:description">
    <meta name='twitter:card' content='summary'>
    <meta name="description" content=unquoted>
    <meta charset="utf-8">
    <meta property="og:image">
  `);
  ok('property/name/itemprop captured', metas.length >= 4, metas);
  ok('attribute order does not matter', metas.some((m) => m.key === 'og:description' && m.content === 'reversed order'));
  ok('single quotes accepted', metas.some((m) => m.key === 'twitter:card' && m.content === 'summary'));
  ok('unquoted value accepted', metas.some((m) => m.key === 'description' && m.content === 'unquoted'));
  ok('meta without content skipped', !metas.some((m) => m.key === 'og:image'));

  // -------------------------------------------------------------------------
  console.log('\nunfurl — extractMeta');
  // -------------------------------------------------------------------------
  const full = u.extractMeta(`<html><head>
    <title>fallback title</title>
    <meta property="og:title" content="OG &amp; Title">
    <meta property="og:description" content="  spaced   out   description  ">
    <meta property="og:image" content="/img/hero.png">
    <meta property="og:image:url" content="https://cdn.example.com/big.png">
    <meta property="og:site_name" content="Example Co">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary">
    <link rel="shortcut icon" href="favicon.ico">
  </head><body></body></html>`, 'https://www.example.com/a/b?c=1');

  eq('og:title wins over <title>', full.title, 'OG & Title');
  eq('description whitespace collapsed', full.description, 'spaced out description');
  eq('og:image:url preferred and absolutised', full.image, 'https://cdn.example.com/big.png');
  eq('site name', full.siteName, 'Example Co');
  eq('twitter:card honoured', full.card, 'summary');
  eq('type', full.type, 'article');
  eq('relative icon resolved', full.icon, 'https://www.example.com/a/favicon.ico');
  eq('ok flag', full.ok, true);

  const minimal = u.extractMeta('<html><head><title>Only a Title</title></head></html>', 'https://news.example.org/story');
  eq('title falls back to <title>', minimal.title, 'Only a Title');
  eq('siteName falls back to host (www stripped)', minimal.siteName, 'news.example.org');
  eq('card defaults to large image when og:type present?', minimal.card, 'summary');
  eq('no image', minimal.image, '');

  const empty = u.extractMeta('', 'https://bare.example.com/');
  eq('empty page still returns a usable title', empty.title, 'bare.example.com');

  const longTitle = u.extractMeta('<meta property="og:title" content="' + 'x'.repeat(400) + '">', 'https://a.example.com/');
  ok('title clipped to 200 chars', longTitle.title.length === 200 && longTitle.title.endsWith('\u2026'), longTitle.title.length);

  const dataImg = u.extractMeta('<meta property="og:image" content="data:image/png;base64,AAAA">', 'https://a.example.com/');
  eq('data: images dropped', dataImg.image, '');

  // complete twitter fallback chain
  const tw = u.extractMeta(`<meta name="twitter:title" content="TW title">
    <meta name="twitter:description" content="TW desc">
    <meta name="twitter:image" content="https://pbs.twimg.com/x.jpg">
    <meta name="twitter:site" content="@example">`, 'https://twitter.com/x/status/1');
  eq('twitter:title used when no og', tw.title, 'TW title');
  eq('twitter:description used', tw.description, 'TW desc');
  eq('twitter:image used', tw.image, 'https://pbs.twimg.com/x.jpg');
  eq('twitter:site becomes siteName', tw.siteName, '@example');

  // -------------------------------------------------------------------------
  console.log('\nunfurl — SSRF guard (IPv4 ranges)');
  // -------------------------------------------------------------------------
  const blockedV4 = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255',
    '169.254.169.254', '169.254.1.1', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '240.0.0.1', '192.0.2.5', '198.18.0.1', '203.0.113.9',
  ];
  for (const ip of blockedV4) ok(`${ip} blocked`, u.isBlockedIp(ip) === true);
  const allowedV4 = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '93.184.216.34'];
  for (const ip of allowedV4) ok(`${ip} allowed`, u.isBlockedIp(ip) === false);

  console.log('\nunfurl — SSRF guard (IPv6 + names)');
  for (const ip of ['::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '[::1]']) {
    ok(`${ip} blocked`, u.isBlockedIp(ip) === true);
  }
  ok('2606:4700::1111 allowed', u.isBlockedIp('2606:4700::1111') === false);
  for (const host of ['localhost', 'app.localhost', 'foo.local', 'metadata.google.internal', 'nas.lan', 'x.corp', '']) {
    ok(`hostname ${host || '(empty)'} blocked`, u.blockedHostname(host) === true);
  }
  for (const host of ['example.com', 'www.example.com.', 'helio.app']) {
    ok(`hostname ${host} allowed`, u.blockedHostname(host) === false);
  }

  // -------------------------------------------------------------------------
  console.log('\nunfurl — parseTarget');
  // -------------------------------------------------------------------------
  ok('https passes', u.parseTarget('https://example.com/x').ok === true);
  ok('file: refused', u.parseTarget('file:///etc/passwd').ok === false);
  ok('javascript: refused', u.parseTarget('javascript:alert(1)').ok === false);
  ok('gopher: refused', u.parseTarget('gopher://example.com/').ok === false);
  ok('credentials refused', u.parseTarget('https://u:p@example.com/').ok === false);
  ok('literal 127.0.0.1 refused', u.parseTarget('http://127.0.0.1:8080/admin').ok === false);
  ok('literal metadata IP refused', u.parseTarget('http://169.254.169.254/latest/meta-data/').ok === false);
  ok('literal [::1] refused', u.parseTarget('http://[::1]:9222/json').ok === false);
  ok('localhost refused', u.parseTarget('http://localhost:9333/json').ok === false);
  ok('garbage refused', u.parseTarget('not a url').ok === false);
  ok('empty refused', u.parseTarget('').ok === false);

  // -------------------------------------------------------------------------
  console.log('\nunfurl — looksUnfurlable');
  // -------------------------------------------------------------------------
  const cases = [
    ['https://example.com/story', true],
    ['http://example.com', true],
    ['https://example.com/photo.JPG', false],
    ['https://example.com/doc.pdf', false],
    ['https://example.com/video.mp4?x=1', false],
    ['ftp://example.com/x', false],
    ['mailto:a@b.c', false],
    ['https://127.0.0.1/x', false],
    ['//example.com/x', false],
    ['', false],
  ];
  for (const [input, expected] of cases) ok(`${input || '(empty)'} → ${expected}`, u.looksUnfurlable(input) === expected);

  // -------------------------------------------------------------------------
  console.log('\nunfurl — live server behind the guard is refused');
  // -------------------------------------------------------------------------
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>SHOULD NEVER BE REACHED</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const local = await u.unfurl(`http://127.0.0.1:${port}/secret`, { useCache: false });
  ok('loopback literal refused before any request', local.ok === false && /private address|cannot be previewed/.test(local.message), local);
  const localName = await u.unfurl(`http://localhost:${port}/secret`, { useCache: false });
  ok('localhost name refused', localName.ok === false, localName);
  await new Promise((r) => server.close(r));

  // -------------------------------------------------------------------------
  console.log('\nunfurl — cache');
  // -------------------------------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-unfurl-'));
  const cache = { version: 1, entries: {
    'https://cached.example.com/page': { at: Date.now(), data: { ok: true, url: 'https://cached.example.com/page', title: 'Cached Title', description: 'd', image: '', icon: '', siteName: 'cached.example.com', card: 'summary', type: '' } },
    'https://stale.example.com/page': { at: Date.now() - u.CACHE_TTL_MS - 1000, data: { ok: true, url: 'https://stale.example.com/page', title: 'Stale', description: '', image: '', icon: '', siteName: '', card: 'summary', type: '' } },
  } };
  u.writeCache(u.cacheFile(dir), cache);
  ok('cache file written', fs.existsSync(u.cacheFile(dir)));
  const cached = await u.unfurl('https://cached.example.com/page', { dataDir: dir });
  ok('cache hit served without network', cached.ok === true && cached.title === 'Cached Title' && cached.cached === true, cached);
  const stale = await u.unfurl('https://stale.example.com/page', { dataDir: dir });
  ok('expired cache entry refetched (no network → clean failure)', stale.ok === false && stale.cached === undefined, stale);

  // cache pruning
  const big = { version: 1, entries: {} };
  for (let i = 0; i < 620; i++) big.entries['https://x' + i + '.example.com/'] = { at: i, data: { ok: true } };
  u.writeCache(u.cacheFile(dir), big);
  const pruned = u.readCache(u.cacheFile(dir));
  ok('cache pruned to its cap', Object.keys(pruned.entries).length <= 500, Object.keys(pruned.entries).length);
  ok('newest entries survive pruning', !!pruned.entries['https://x619.example.com/']);

  const corrupt = path.join(dir, 'unfurl-cache.json');
  fs.writeFileSync(corrupt, 'not json at all');
  const recovered = u.readCache(corrupt);
  ok('corrupt cache recovers to empty', recovered && recovered.entries && Object.keys(recovered.entries).length === 0);

  // -------------------------------------------------------------------------
  console.log('\nunfurl — unfurlMany');
  // -------------------------------------------------------------------------
  const many = await u.unfurlMany(['https://127.0.0.1/a', 'https://127.0.0.1/a', 'file:///etc/passwd'], { useCache: false });
  eq('deduplicates and caps', many.length, 2);
  ok('each entry reports its own failure', many.every((m) => m.ok === false), many.map((m) => m.message));

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
