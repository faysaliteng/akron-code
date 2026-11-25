'use strict';
// Akron Bot — live connector feed from the official Model Context Protocol registry.
//
// The built-in `connector-catalog.js` is a curated snapshot so the directory is
// useful offline. This module adds the long tail: it pulls servers from
// https://registry.modelcontextprotocol.io, de-duplicates versions, maps them to
// the same connector shape the UI already renders, and caches them on disk.
//
// Cache: ~/.autobot/mcp-registry.json   { fetchedAt, entries: [...] }
// Entry: { id: 'mcp:<slug>', name, type:'connector', category, auth, description,
//          tools: [], endpoint?: {type:'http'|'sse', url}, command?: {...},
//          origin:'registry', serverName, version, repoUrl }

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const CACHE_FILE = path.join(DATA_DIR, 'mcp-registry.json');
const API = 'https://registry.modelcontextprotocol.io/v0/servers';
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;
const MAX_PAGES = 15;
const PAGE = 100;

let entries = [];
let fetchedAt = 0;
let inflight = null;
let lastError = null;

// ---- helpers --------------------------------------------------------------
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j.version !== CACHE_VERSION) return; // schema changed: refetch
    if (Array.isArray(j.entries)) entries = j.entries;
    fetchedAt = j.fetchedAt || 0;
  } catch (_) {}
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, fetchedAt, entries }));
  } catch (_) {}
}

// Categorize by keyword so the UI filter stays meaningful for the long tail.
const CATEGORY_HINTS = [
  [/github|gitlab|bitbucket|\bcode\b|\brepo\b|sentry|datadog|\bci\b|deploy|docker|kube|terraform|vercel|netlify|npm|pypi/i, 'Engineering'],
  [/slack|discord|telegram|whatsapp|\bteams\b|\bchat\b|\bsms\b|twilio|zoom|meet\b|matrix|mattermost/i, 'Communication'],
  [/gmail|\bmail\b|imap|smtp|outlook|inbox|email/i, 'Email'],
  [/calendar|schedul|calendly|booking/i, 'Calendar'],
  [/\bsql\b|postgres|mysql|mongo|redis|database|snowflake|bigquery|duckdb|sqlite|vector|pinecone|qdrant|clickhouse|neo4j/i, 'Data'],
  [/analytics|metric|track|mixpanel|amplitude|posthog|segment|report|dashboard/i, 'Analytics'],
  [/\baws\b|\bgcp\b|azure|cloud|\bs3\b|storage|bucket|drive|dropbox|\bbox\b|onedrive|file|s3/i, 'Cloud'],
  [/stripe|payment|invoice|billing|finance|paypal|ledger|bank|accounting|ledger/i, 'Finance'],
  [/\bcrm\b|sales|lead\b|deal\b|hubspot|salesforce|pipedrive/i, 'Sales'],
  [/support|ticket|zendesk|intercom|helpdesk|incident|pagerduty/i, 'Support'],
  [/design|figma|canva|image|photo|video|media|music|sketch|svg/i, 'Design'],
  [/browser|scrape|crawl|fetch|search|web|http|\burl\b/i, 'Web'],
  [/memory|note|knowledge|wiki|notion|obsidian|\bdoc\b|document/i, 'Productivity'],
  [/security|vuln|scan|pentest|\bcve\b|threat|osint/i, 'Security'],
  [/\bai\b|\bllm\b|\bmodel\b|openai|anthropic|embedding|\bml\b|inference/i, 'AI'],
];

function categorize(server) {
  const hay = [server.name, server.title, server.description].filter(Boolean).join(' ');
  for (const [re, cat] of CATEGORY_HINTS) if (re.test(hay)) return cat;
  return 'Other';
}

function pickRemote(remotes) {
  if (!Array.isArray(remotes) || !remotes.length) return null;
  const http = remotes.find((r) => r && (r.type === 'streamable-http' || r.type === 'http'));
  const sse = remotes.find((r) => r && r.type === 'sse');
  const pick = http || sse || remotes[0];
  if (!pick || !pick.url) return null;
  return { type: pick.type === 'sse' ? 'sse' : 'http', url: String(pick.url) };
}

function pickCommand(packages) {
  if (!Array.isArray(packages) || !packages.length) return null;
  const p = packages.find((x) => x && x.registryType === 'npm') || packages[0];
  if (!p) return null;
  const runtime = p.runtimeHint || (p.registryType === 'npm' ? 'npx' : p.registryType === 'pypi' ? 'uvx' : null);
  if (!runtime || !p.identifier) return null;
  const args = runtime === 'npx' ? ['-y', p.identifier] : [p.identifier];
  return { command: runtime, args };
}

function mapServer(server, meta) {
  const remote = pickRemote(server.remotes);
  const cmd = remote ? null : pickCommand(server.packages);
  if (!remote && !cmd) return null;
  const name = server.title || server.name.split('/').pop() || server.name;
  return {
    id: 'mcp:' + slug(server.name),
    name,
    type: 'connector',
    category: categorize(server),
    auth: remote ? 'oauth' : 'none',
    description: String(server.description || '').replace(/\s+/g, ' ').slice(0, 300),
    tools: [],
    origin: 'registry',
    serverName: server.name,
    version: server.version || meta && meta.version || '',
    repoUrl: server.repository && server.repository.url || undefined,
    ...(remote ? { endpoint: remote } : {}),
    ...(cmd ? { command: cmd } : {}),
  };
}

// ---- fetch ----------------------------------------------------------------
async function fetchPage(cursor) {
  const url = API + '?limit=' + PAGE + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('registry HTTP ' + res.status);
  return res.json();
}

async function refresh(opts) {
  if (inflight) return inflight;
  const maxPages = Math.min((opts && opts.maxPages) || MAX_PAGES, MAX_PAGES);
  inflight = (async () => {
    const seen = new Map();
    let cursor = '';
    let pages = 0;
    try {
      while (pages < maxPages) {
        const j = await fetchPage(cursor);
        const rows = (j && j.servers) || [];
        for (const row of rows) {
          const server = row && row.server;
          if (!server || !server.name) continue;
          const meta = row._meta && row._meta['io.modelcontextprotocol.registry/official'];
          if (meta && meta.status && meta.status !== 'active') continue;
          const prev = seen.get(server.name);
          // keep the newest: registry bumps `isLatest`, else last write wins
          if (prev && meta && prev.latest && !meta.isLatest) continue;
          const mapped = mapServer(server, meta);
          if (!mapped) continue;
          mapped.latest = !!(meta && meta.isLatest);
          seen.set(server.name, mapped);
        }
        pages++;
        cursor = j && j.metadata && j.metadata.nextCursor;
        if (!cursor) break;
      }
      entries = [...seen.values()];
      fetchedAt = Date.now();
      lastError = null;
      saveCache();
      return { ok: true, count: entries.length, pages };
    } catch (err) {
      lastError = err.message;
      return { ok: false, error: err.message, count: entries.length };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function stale() { return !fetchedAt || Date.now() - fetchedAt > TTL_MS; }

// Non-blocking: never make a UI click wait on the network.
function maybeRefresh() {
  if (inflight || !stale()) return;
  refresh().catch(() => {});
}

// ---- query ----------------------------------------------------------------
function all() { loadOnce(); return entries; }

let loaded = false;
function loadOnce() { if (!loaded) { loaded = true; loadCache(); maybeRefresh(); } }

function get(id) {
  loadOnce();
  return entries.find((e) => e.id === id) || null;
}

function score(e, terms) {
  const hay = (e.name + ' ' + e.serverName + ' ' + e.description + ' ' + e.category).toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!t) continue;
    if (e.name.toLowerCase().includes(t)) s += 8;
    if (hay.includes(t)) s += 3;
  }
  return s;
}

function search(query, limit) {
  loadOnce();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries.slice(0, limit || 24);
  return entries
    .map((e) => ({ e, s: score(e, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit || 24)
    .map((x) => x.e);
}

function suggest(goal, limit) {
  const words = String(goal || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return entries
    .map((e) => {
      const hay = (e.name + ' ' + e.description + ' ' + e.category).toLowerCase();
      let s = 0;
      for (const w of words) if (hay.includes(w)) s += 1;
      return { e, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit || 5)
    .map((x) => x.e);
}

function status() {
  loadOnce();
  return { count: entries.length, fetchedAt, stale: stale(), refreshing: !!inflight, lastError };
}

module.exports = { all, get, search, suggest, refresh, maybeRefresh, status, stale, _map: mapServer, _slug: slug };
