'use strict';
// Helio Bot — Plugins & Connectors directory (Example Desktop parity).
//
// Example Desktop ships a directory of connectors (remote MCP servers) plus
// installable plugins. Helio Bot reproduces that surface locally: a curated
// catalog with categories, search, install/uninstall state persisted to
// ~/.autobot/plugins.json, and model-facing tools
// (plugins__list_plugins / search_plugins / search_connectors /
//  suggest_plugin_install / mcp-registry__*).
//
// Installing a connector does NOT ship third-party code: it records intent and,
// when the catalog entry carries an MCP endpoint, registers it with the MCP
// client so its tools become available. Entries without an endpoint (OAuth-only
// hosted connectors) are marked "requires sign-in" — installing them adds them
// to the Installed list and the model can suggest the sign-in step.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJSON(file, v) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }

// ---- Catalog ---------------------------------------------------------------
// type: 'connector' = hosted MCP integration; 'plugin' = capability bundle.
// auth: 'oauth' | 'apikey' | 'none'
const CATALOG = [
  // --- Productivity / docs ---
  { id: 'gdrive', name: 'Google Drive', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Search, read, and reference files in Google Drive and shared drives.',
    tools: ['search_files', 'read_file', 'list_folder'] },
  { id: 'gdocs', name: 'Google Docs', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Read and summarize Google Docs, comments, and suggestions.',
    tools: ['get_document', 'list_comments'] },
  { id: 'gmail', name: 'Gmail', type: 'connector', category: 'Communication', auth: 'oauth',
    description: 'Search and read email threads; draft replies without sending.',
    tools: ['search_threads', 'get_thread', 'draft_reply'] },
  { id: 'gcal', name: 'Google Calendar', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Look up events, find free time, and summarize your schedule.',
    tools: ['list_events', 'find_free_time'] },
  { id: 'notion', name: 'Notion', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Search and read Notion pages and databases.',
    tools: ['search', 'get_page', 'query_database'] },
  { id: 'slack', name: 'Slack', type: 'connector', category: 'Communication', auth: 'oauth',
    description: 'Search channels and threads, read messages, and summarize conversations.',
    tools: ['search_messages', 'get_channel_history', 'list_channels'] },
  { id: 'linear', name: 'Linear', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Search and read Linear issues, projects, and cycles.',
    tools: ['search_issues', 'get_issue', 'list_projects'] },
  { id: 'jira', name: 'Jira', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Search Jira issues with JQL and read issue details.',
    tools: ['search_issues', 'get_issue'] },
  { id: 'github', name: 'GitHub', type: 'connector', category: 'Engineering', auth: 'oauth',
    description: 'Search repositories, read issues and pull requests, and inspect code.',
    tools: ['search_repos', 'get_issue', 'list_pulls', 'get_file'] },
  { id: 'gitlab', name: 'GitLab', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Search projects, merge requests, and issues on GitLab.',
    tools: ['search_projects', 'list_merge_requests'] },
  { id: 'sentry', name: 'Sentry', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Look up errors and issues captured by Sentry.',
    tools: ['list_issues', 'get_event'] },
  { id: 'vercel', name: 'Vercel', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Inspect deployments, builds, and project configuration on Vercel.',
    tools: ['list_deployments', 'get_deployment'] },
  { id: 'asana', name: 'Asana', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Search and read Asana tasks and projects.',
    tools: ['search_tasks', 'list_projects'] },
  { id: 'trello', name: 'Trello', type: 'connector', category: 'Productivity', auth: 'apikey',
    description: 'Read Trello boards, lists, and cards.',
    tools: ['list_boards', 'get_cards'] },
  { id: 'monday', name: 'monday.com', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Search monday.com boards and items.',
    tools: ['list_boards', 'search_items'] },
  { id: 'clickup', name: 'ClickUp', type: 'connector', category: 'Productivity', auth: 'apikey',
    description: 'Search and read ClickUp tasks and spaces.',
    tools: ['search_tasks', 'list_spaces'] },
  { id: 'airtable', name: 'Airtable', type: 'connector', category: 'Data', auth: 'apikey',
    description: 'Query Airtable bases and read records.',
    tools: ['list_records', 'get_base_schema'] },
  { id: 'hubspot', name: 'HubSpot', type: 'connector', category: 'Sales', auth: 'oauth',
    description: 'Search CRM contacts, companies, and deals.',
    tools: ['search_contacts', 'search_deals'] },
  { id: 'salesforce', name: 'Salesforce', type: 'connector', category: 'Sales', auth: 'oauth',
    description: 'Query Salesforce records with SOQL.',
    tools: ['soql_query', 'get_record'] },
  { id: 'stripe', name: 'Stripe', type: 'connector', category: 'Finance', auth: 'apikey',
    description: 'Read customers, payments, subscriptions, and invoices (read-only).',
    tools: ['list_customers', 'list_payments', 'get_balance'] },
  { id: 'quickbooks', name: 'QuickBooks', type: 'connector', category: 'Finance', auth: 'oauth',
    description: 'Read invoices, expenses, and financial reports.',
    tools: ['list_invoices', 'get_report'] },
  { id: 'xero', name: 'Xero', type: 'connector', category: 'Finance', auth: 'oauth',
    description: 'Read Xero invoices, contacts, and bank transactions.',
    tools: ['list_invoices', 'list_contacts'] },
  { id: 'intercom', name: 'Intercom', type: 'connector', category: 'Support', auth: 'apikey',
    description: 'Search conversations and read customer support threads.',
    tools: ['search_conversations', 'get_contact'] },
  { id: 'zendesk', name: 'Zendesk', type: 'connector', category: 'Support', auth: 'apikey',
    description: 'Search support tickets and read ticket history.',
    tools: ['search_tickets', 'get_ticket'] },
  { id: 'figma', name: 'Figma', type: 'connector', category: 'Design', auth: 'oauth',
    description: 'Read Figma files, frames, and design comments.',
    tools: ['get_file', 'list_comments'] },
  { id: 'canva', name: 'Canva', type: 'connector', category: 'Design', auth: 'oauth',
    description: 'Search and read Canva designs.',
    tools: ['search_designs', 'get_design'] },
  { id: 'miro', name: 'Miro', type: 'connector', category: 'Design', auth: 'oauth',
    description: 'Read Miro boards and sticky notes.',
    tools: ['list_boards', 'get_items'] },
  { id: 'confluence', name: 'Confluence', type: 'connector', category: 'Productivity', auth: 'oauth',
    description: 'Search and read Confluence pages and spaces.',
    tools: ['search_pages', 'get_page'] },
  { id: 'dropbox', name: 'Dropbox', type: 'connector', category: 'Storage', auth: 'oauth',
    description: 'Search and read files stored in Dropbox.',
    tools: ['search_files', 'read_file'] },
  { id: 'box', name: 'Box', type: 'connector', category: 'Storage', auth: 'oauth',
    description: 'Search and read files stored in Box.',
    tools: ['search_files', 'read_file'] },
  { id: 'sharepoint', name: 'SharePoint', type: 'connector', category: 'Storage', auth: 'oauth',
    description: 'Search and read SharePoint sites and documents.',
    tools: ['search_sites', 'read_document'] },
  { id: 'onedrive', name: 'OneDrive', type: 'connector', category: 'Storage', auth: 'oauth',
    description: 'Search and read files stored in OneDrive.',
    tools: ['search_files', 'read_file'] },
  { id: 'supabase', name: 'Supabase', type: 'connector', category: 'Data', auth: 'apikey',
    description: 'Inspect Supabase tables and run read-only SQL.',
    tools: ['list_tables', 'run_query'] },
  { id: 'postgres', name: 'PostgreSQL', type: 'connector', category: 'Data', auth: 'apikey',
    description: 'Connect to a PostgreSQL database and run read-only queries.',
    tools: ['list_tables', 'run_query'] },
  { id: 'snowflake', name: 'Snowflake', type: 'connector', category: 'Data', auth: 'apikey',
    description: 'Query Snowflake warehouses with SQL.',
    tools: ['list_databases', 'run_query'] },
  { id: 'bigquery', name: 'BigQuery', type: 'connector', category: 'Data', auth: 'oauth',
    description: 'Query Google BigQuery datasets.',
    tools: ['list_datasets', 'run_query'] },
  { id: 'datadog', name: 'Datadog', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'Query Datadog monitors, logs, and metrics.',
    tools: ['search_logs', 'list_monitors'] },
  { id: 'pagerduty', name: 'PagerDuty', type: 'connector', category: 'Engineering', auth: 'apikey',
    description: 'List incidents and on-call schedules.',
    tools: ['list_incidents', 'list_schedules'] },
  { id: 'aws', name: 'AWS', type: 'connector', category: 'Cloud', auth: 'apikey',
    description: 'Inspect AWS resources (read-only) across common services.',
    tools: ['list_resources', 'describe_resource'] },
  { id: 'cloudflare', name: 'Cloudflare', type: 'connector', category: 'Cloud', auth: 'apikey',
    description: 'Inspect Cloudflare zones, DNS records, and analytics.',
    tools: ['list_zones', 'list_dns_records'] },
  { id: 'gcloud', name: 'Google Cloud', type: 'connector', category: 'Cloud', auth: 'oauth',
    description: 'Inspect Google Cloud projects and resources.',
    tools: ['list_projects', 'list_resources'] },

  // --- Plugins (capability bundles) ---
  { id: 'plugin-deep-research', name: 'Deep Research', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Multi-step research: plans queries, reads sources, and writes a cited report.',
    provides: ['deep_research'] },
  { id: 'plugin-data-analyst', name: 'Data Analyst', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Loads tabular data, runs analysis in a sandbox, and renders charts.',
    provides: ['code_execution', 'visualize'] },
  { id: 'plugin-web-designer', name: 'Web Designer', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Builds polished single-file HTML/CSS/JS pages and previews them in the browser pane.',
    provides: ['browser', 'artifact'] },
  { id: 'plugin-docs-writer', name: 'Docs Writer', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Drafts and formats long-form documents (Markdown, DOCX, PDF export).',
    provides: ['artifact', 'pdf_export'] },
  { id: 'plugin-slides', name: 'Slide Deck Builder', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Turns an outline into a styled presentation deck.',
    provides: ['artifact'] },
  { id: 'plugin-spreadsheet', name: 'Spreadsheet Builder', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Creates and edits XLSX/CSV workbooks with formulas and formatting.',
    provides: ['code_execution', 'artifact'] },
  { id: 'plugin-code-reviewer', name: 'Code Reviewer', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Reviews diffs and repositories for bugs, security issues, and style problems.',
    provides: ['code_review', 'git'] },
  { id: 'plugin-security-auditor', name: 'Security Auditor', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Runs OWASP-style audits over code and live applications.',
    provides: ['code_review', 'browser', 'web_fetch'] },
  { id: 'plugin-translator', name: 'Translator', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Translates documents and UI strings across 50+ languages.',
    provides: ['i18n'] },
  { id: 'plugin-voice-scribe', name: 'Voice Scribe', type: 'plugin', category: 'Plugins', auth: 'none',
    description: 'Records and transcribes meetings, then summarizes action items.',
    provides: ['voice', 'transcribe'] },
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

// ---- Install state ---------------------------------------------------------
function getState() {
  const s = readJSON(PLUGINS_FILE, { installed: {}, config: {} });
  if (!s.installed) s.installed = {};
  if (!s.config) s.config = {};
  return s;
}
function saveState(s) { writeJSON(PLUGINS_FILE, s); }

function decorate(entry, state) {
  const inst = state.installed[entry.id];
  return {
    ...entry,
    installed: !!inst,
    installedAt: inst ? inst.at : null,
    requiresSignIn: !!inst && entry.auth !== 'none' && !(state.config[entry.id] && state.config[entry.id].connected),
    connected: !!(state.config[entry.id] && state.config[entry.id].connected),
  };
}

function listPlugins(opts) {
  const state = getState();
  let list = CATALOG.map((e) => decorate(e, state));
  if (opts && opts.type) list = list.filter((e) => e.type === opts.type);
  if (opts && opts.category) list = list.filter((e) => e.category === opts.category);
  if (opts && opts.installedOnly) list = list.filter((e) => e.installed);
  return list;
}

function categories() {
  const set = new Set(CATALOG.map((e) => e.category));
  return [...set];
}

function score(entry, terms) {
  const hay = (entry.name + ' ' + entry.id + ' ' + entry.description + ' ' + entry.category + ' ' + (entry.tools || []).join(' ') + ' ' + (entry.provides || []).join(' ')).toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!t) continue;
    if (entry.name.toLowerCase().includes(t)) s += 8;
    if (hay.includes(t)) s += 3;
    if (hay.split(/\W+/).includes(t)) s += 2;
  }
  return s;
}

function search(query, opts) {
  const q = String(query || '').trim().toLowerCase();
  const state = getState();
  let pool = CATALOG;
  if (opts && opts.type) pool = pool.filter((e) => e.type === opts.type);
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = pool.map((e) => ({ e, s: terms.length ? score(e, terms) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => decorate(x.e, state));
  const limit = (opts && opts.limit) || 12;
  return scored.slice(0, limit);
}

function suggest(goal, opts) {
  // Rank by keyword overlap between the goal and the entry description.
  const q = String(goal || '').toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const state = getState();
  const pool = CATALOG.filter((e) => !state.installed[e.id]);
  const scored = pool.map((e) => {
    const hay = (e.name + ' ' + e.description + ' ' + e.category + ' ' + (e.tools || []).join(' ') + ' ' + (e.provides || []).join(' ')).toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 1;
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const top = scored.slice(0, (opts && opts.limit) || 5).map((x) => decorate(x.e, state));
  return top;
}

function install(id, config) {
  const entry = BY_ID.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const state = getState();
  state.installed[id] = { at: Date.now() };
  if (config) state.config[id] = { ...(state.config[id] || {}), ...config };
  saveState(state);
  return { ok: true, entry: decorate(entry, state) };
}

function uninstall(id) {
  const state = getState();
  if (!state.installed[id]) return { ok: false, error: `Not installed: ${id}` };
  delete state.installed[id];
  delete state.config[id];
  saveState(state);
  return { ok: true, id };
}

function markConnected(id) {
  const state = getState();
  state.config[id] = { ...(state.config[id] || {}), connected: true, connectedAt: Date.now() };
  saveState(state);
  const entry = BY_ID.get(id);
  return entry ? decorate(entry, state) : null;
}

function setConfig(id, patch) {
  const state = getState();
  state.config[id] = { ...(state.config[id] || {}), ...(patch || {}) };
  saveState(state);
  const entry = BY_ID.get(id);
  return entry ? decorate(entry, state) : null;
}

// Format a catalog slice for the model.
function formatList(list, title) {
  if (!list || !list.length) return (title || 'RESULTS') + ':\n(none)';
  const lines = list.map((e) => {
    const st = e.installed ? (e.requiresSignIn ? ' · installed, needs sign-in' : ' · installed') : '';
    return `- ${e.name} [${e.type}/${e.category}] (${e.id})${st}\n    ${e.description}`;
  });
  return (title || 'RESULTS') + ':\n' + lines.join('\n');
}

function formatSuggest(list, goal) {
  if (!list || !list.length) return `No matching connectors found for: ${goal}`;
  const lines = list.map((e, i) => `${i + 1}. ${e.name} (${e.id}) — ${e.description}${e.installed ? ' [installed]' : ''}`);
  return `Suggested for "${goal}":\n` + lines.join('\n') + '\n\nInstall with: plugins install ' + list[0].id;
}

module.exports = {
  CATALOG,
  listPlugins,
  categories,
  search,
  suggest,
  install,
  uninstall,
  markConnected,
  setConfig,
  getState,
  formatList,
  formatSuggest,
  get: (id) => BY_ID.get(id) || null,
};
