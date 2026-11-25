// Helio Bot — connector / plugin logo resolution.
//
// The directory shows ~960 rows and each card needs recognisable art, the way
// the desktop app's connector browser does. No logo CDN ships with the app, so
// we resolve the service's own origin and let the renderer paint the site's
// real icon (apple-touch-icon → favicon). When a domain is wrong, offline, or
// blocks the image the card falls back to a deterministic monogram tile — never
// a broken image and never a generic globe.
//
// Pure data + pure functions: no network, no Electron.

// id → origin that serves the service's brand icon.
export const BRAND_DOMAIN = {
  // ---- Productivity / docs ----
  gdrive: 'drive.google.com', gdocs: 'docs.google.com', gsheets: 'docs.google.com',
  gslides: 'docs.google.com', gforms: 'docs.google.com', gkeep: 'keep.google.com',
  gsites: 'sites.google.com', gtasks: 'tasks.google.com', notion: 'notion.so',
  'notion-projects': 'notion.so', confluence: 'atlassian.com', coda: 'coda.io',
  quip: 'quip.com', slite: 'slite.com', craft: 'craft.do', obsidian: 'obsidian.md',
  logseq: 'logseq.com', evernote: 'evernote.com', onenote: 'onenote.com',
  'dropbox-paper': 'dropbox.com', readwise: 'readwise.io', granola: 'granola.ai',
  otter: 'otter.ai', fireflies: 'fireflies.ai', fathom: 'fathom.video', tldv: 'tldv.io',
  loom: 'loom.com', miro: 'miro.com', whimsical: 'whimsical.com', lucid: 'lucid.co',
  excalidraw: 'excalidraw.com', figma: 'figma.com', canva: 'canva.com', sketch: 'sketch.com',
  invision: 'invisionapp.com', zeplin: 'zeplin.io', framer: 'framer.com',
  webflow: 'webflow.com', spline: 'spline.design', penpot: 'penpot.app',
  storybook: 'storybook.js.org', chromatic: 'chromatic.com', coolors: 'coolors.co',
  unsplash: 'unsplash.com', 'adobe-cc': 'adobe.com',

  // ---- Project & task management ----
  asana: 'asana.com', trello: 'trello.com', monday: 'monday.com', clickup: 'clickup.com',
  basecamp: 'basecamp.com', wrike: 'wrike.com', smartsheet: 'smartsheet.com',
  'smartsheet-data': 'smartsheet.com', height: 'height.app', shortcut: 'shortcut.com',
  planner: 'microsoft.com', todoist: 'todoist.com', ticktick: 'ticktick.com',
  things: 'culturedcode.com', motion: 'usemotion.com', sunsama: 'sunsama.com',
  reclaim: 'reclaim.ai', clockwise: 'clockwise.com', teamwork: 'teamwork.com',
  podio: 'podio.com', 'airtable-projects': 'airtable.com', 'airtable-realestate': 'airtable.com',

  // ---- Messaging / meetings ----
  slack: 'slack.com', 'slack-canvas': 'slack.com', teams: 'microsoft.com',
  discord: 'discord.com', 'telegram-bot': 'telegram.org',
  'whatsapp-business': 'whatsapp.com', zoom: 'zoom.us', webex: 'webex.com',
  ringcentral: 'ringcentral.com', twilio: 'twilio.com', 'twilio-automation': 'twilio.com',
  sendgrid: 'sendgrid.com', mailchimp: 'mailchimp.com', klaviyo: 'klaviyo.com',
  customerio: 'customer.io', front: 'front.com', 'front-support': 'front.com',
  missive: 'missiveapp.com', gong: 'gong.io', chorus: 'chorus.ai', fellow: 'fellow.app',
  mattermost: 'mattermost.com', 'rocket-chat': 'rocket.chat', gmail: 'gmail.com',
  'outlook-mail': 'outlook.com', superhuman: 'superhuman.com', fastmail: 'fastmail.com',
  protonmail: 'proton.me', imap: 'mail.google.com',

  // ---- Calendar ----
  gcal: 'calendar.google.com', 'outlook-cal': 'outlook.com', calendly: 'calendly.com',
  'cal-com': 'cal.com', savvycal: 'savvycal.com', cronofy: 'cronofy.com', nylas: 'nylas.com',

  // ---- Dev / CI ----
  github: 'github.com', 'github-official': 'github.com', 'gh-actions': 'github.com',
  gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', 'azure-devops': 'dev.azure.com',
  jira: 'atlassian.com', 'jira-service-management': 'atlassian.com', linear: 'linear.app',
  sentry: 'sentry.io', datadog: 'datadoghq.com', newrelic: 'newrelic.com',
  grafana: 'grafana.com', splunk: 'splunk.com', elastic: 'elastic.co', kibana: 'elastic.co',
  vercel: 'vercel.com', netlify: 'netlify.com', render: 'render.com', railway: 'railway.app',
  flyio: 'fly.io', heroku: 'heroku.com', 'cloudflare-pages': 'cloudflare.com',
  circleci: 'circleci.com', buildkite: 'buildkite.com', jenkins: 'jenkins.io',
  travis: 'travis-ci.com', argocd: 'argoproj.github.io', terraform: 'terraform.io',
  pulumi: 'pulumi.com', 'docker-hub': 'docker.com', kubernetes: 'kubernetes.io',
  helm: 'helm.sh', postman: 'postman.com', 'apollo-graphql': 'apollographql.com',

  // ---- Analytics ----
  posthog: 'posthog.com', mixpanel: 'mixpanel.com', amplitude: 'amplitude.com',
  segment: 'segment.com', 'google-analytics': 'analytics.google.com',
  plausible: 'plausible.io', matomo: 'matomo.org', hotjar: 'hotjar.com',
  fullstory: 'fullstory.com', heap: 'heap.io', looker: 'looker.com',
  metabase: 'metabase.com', 'metabase-data': 'metabase.com', powerbi: 'microsoft.com',
  tableau: 'tableau.com', superset: 'apache.org',

  // ---- Databases ----
  postgres: 'postgresql.org', mysql: 'mysql.com', mssql: 'microsoft.com',
  'oracle-db': 'oracle.com', sqlite: 'sqlite.org', mongodb: 'mongodb.com',
  redis: 'redis.io', cassandra: 'apache.org', neo4j: 'neo4j.com',
  clickhouse: 'clickhouse.com', timescale: 'timescale.com',
  cockroachdb: 'cockroachlabs.com', snowflake: 'snowflake.com',
  bigquery: 'cloud.google.com', redshift: 'aws.amazon.com', databricks: 'databricks.com',
  trino: 'trino.io', presto: 'prestodb.io', duckdb: 'duckdb.org', supabase: 'supabase.com',
  neon: 'neon.tech', planetscale: 'planetscale.com', prisma: 'prisma.io',
  hasura: 'hasura.io', dbt: 'getdbt.com', fivetran: 'fivetran.com', airbyte: 'airbyte.com',
  kafka: 'apache.org', confluent: 'confluent.io', pinecone: 'pinecone.io',
  weaviate: 'weaviate.io', qdrant: 'qdrant.tech', chroma: 'trychroma.com',
  pgvector: 'github.com', airtable: 'airtable.com', retool: 'retool.com',
  'retool-automation': 'retool.com', milvus: 'milvus.io', singlestore: 'singlestore.com',
  influxdb: 'influxdata.com', questdb: 'questdb.io', turso: 'turso.tech',

  // ---- Cloud / storage ----
  aws: 'aws.amazon.com', gcloud: 'cloud.google.com', azure: 'azure.microsoft.com',
  cloudflare: 'cloudflare.com', digitalocean: 'digitalocean.com', linode: 'linode.com',
  vultr: 'vultr.com', hetzner: 'hetzner.com', 'oracle-cloud': 'oracle.com',
  'alibaba-cloud': 'alibabacloud.com', 'ibm-cloud': 'ibm.com', s3: 'aws.amazon.com',
  gcs: 'cloud.google.com', 'azure-blob': 'azure.microsoft.com', backblaze: 'backblaze.com',
  wasabi: 'wasabi.com', minio: 'min.io', cloudinary: 'cloudinary.com', imgix: 'imgix.com',
  mux: 'mux.com', bunny: 'bunny.net', fastly: 'fastly.com', koyeb: 'koyeb.com',
  northflank: 'northflank.com', modal: 'modal.com', runpod: 'runpod.io',

  // ---- Payments / finance ----
  stripe: 'stripe.com', 'stripe-billing': 'stripe.com', paypal: 'paypal.com',
  square: 'squareup.com', plaid: 'plaid.com', quickbooks: 'quickbooks.intuit.com',
  xero: 'xero.com', netsuite: 'netsuite.com', sage: 'sage.com', freshbooks: 'freshbooks.com',
  wave: 'waveapps.com', bill: 'bill.com', billcom: 'bill.com', ramp: 'ramp.com',
  brex: 'brex.com', mercury: 'mercury.com', chase: 'chase.com', chargebee: 'chargebee.com',
  recurly: 'recurly.com', paddle: 'paddle.com', adyen: 'adyen.com',
  braintree: 'braintreepayments.com', wise: 'wise.com', coinbase: 'coinbase.com',
  binance: 'binance.com', expensify: 'expensify.com', concur: 'concur.com',
  klarna: 'klarna.com', revolut: 'revolut.com', monzo: 'monzo.com', carta: 'carta.com',
  dnb: 'dnb.com',
};

// ---- Everything else: spreadsheets of brands that live under a suite ----
export const BRAND_SIBLING = {
  'google-sheets-data': 'gsheets',
};

// A handful of suites publish every product mark under one branding path, which
// is both sharper and more accurate than the shared site favicon (Google Docs,
// Sheets and Slides all serve the same icon at docs.google.com/favicon.ico).
const G = 'https://www.gstatic.com/images/branding/product/1x/';
export const ICON_URL = {
  gdrive: G + 'drive_2020q4_48dp.png',
  gdocs: G + 'docs_2020q4_48dp.png',
  gsheets: G + 'sheets_2020q4_48dp.png',
  gslides: G + 'slides_2020q4_48dp.png',
  gforms: G + 'forms_2020q4_48dp.png',
  gkeep: G + 'keep_2020q4_48dp.png',
  gsites: G + 'sites_2020q4_48dp.png',
  gmail: G + 'gmail_2020q4_48dp.png',
  gcal: G + 'calendar_2020q4_48dp.png',
};

/** Exact art for a known catalogue id, or ''. */
export function iconOverride(id) {
  return ICON_URL[String(id || '').replace(/^mcp:/, '')] || '';
}

// Plugin ids are roles, not brands: give each a glyph + tint instead.
export const PLUGIN_GLYPH = {
  'plugin-deep-research': 'search', 'plugin-data-analyst': 'chart',
  'plugin-web-designer': 'layout', 'plugin-docs-writer': 'doc',
  'plugin-slides': 'slides', 'plugin-spreadsheet': 'grid',
  'plugin-code-reviewer': 'code', 'plugin-security-auditor': 'shield',
  'plugin-translator': 'globe', 'plugin-translator-docs': 'globe',
  'plugin-voice-scribe': 'mic', 'plugin-test-engineer': 'check',
  'plugin-refactorer': 'code', 'plugin-devops': 'terminal',
  'plugin-dba': 'database', 'plugin-sql-optimizer': 'database',
  'plugin-etl': 'flow', 'plugin-dashboard': 'chart',
  'plugin-statistician': 'chart', 'plugin-screenwriter': 'film',
  'plugin-novelist': 'book', 'plugin-editor': 'pen',
  'plugin-copywriter': 'pen', 'plugin-seo': 'search',
  'plugin-social': 'share', 'plugin-email-marketer': 'mail',
  'plugin-product-manager': 'clipboard', 'plugin-ux-writer': 'pen',
  'plugin-ux-researcher': 'search', 'plugin-accessibility': 'access',
  'plugin-sysadmin': 'terminal', 'plugin-network-debugger': 'network',
  'plugin-incident-commander': 'alert', 'plugin-data-privacy': 'lock',
  'plugin-compliance': 'shield', 'plugin-contract-reader': 'doc',
  'plugin-finance-analyst': 'chart', 'plugin-bookkeeper': 'calc',
  'plugin-investor': 'trend', 'plugin-recruiter': 'users',
  'plugin-teacher': 'book', 'plugin-tutor': 'book',
  'plugin-meeting-notes': 'clipboard', 'plugin-project-planner': 'calendar',
  'plugin-spreadsheet-modeler': 'grid', 'plugin-3d': 'cube',
  'plugin-game-dev': 'gamepad', 'plugin-mobile-dev': 'phone',
  'plugin-api-designer': 'api', 'plugin-data-viz': 'chart',
};

// Plugin tint families (Claude's directory tints role tiles by family).
export const PLUGIN_TINT = {
  plugin: 'violet',
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const HOST_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

/** Best-guess origin for a directory row, or '' when there is none. */
export function domainFor(id, name, url) {
  // A curated brand mapping always beats the endpoint host: catalogue rows
  // point at a protocol host (`mcp.asana.com`) that serves no icon, while the
  // product domain (`asana.com`) serves the real one.
  const key = String(id || '').replace(/^mcp:/, '');
  if (BRAND_SIBLING[key] && BRAND_DOMAIN[BRAND_SIBLING[key]]) return BRAND_DOMAIN[BRAND_SIBLING[key]];
  if (BRAND_DOMAIN[key]) return BRAND_DOMAIN[key];
  if (url) {
    try {
      const h = new URL(url).hostname;
      if (HOST_RE.test(h)) return h.replace(/^(?:mcp|api)[.-]/i, '');
    } catch (_) { /* not a URL */ }
  }
  // registry ids look like `mcp:<org>-<host-slug>`; try the raw slug's name
  const plain = String(name || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*\/.*$/, '')
    .trim()
    .toLowerCase();
  if (!plain) return '';
  const slug = plain.replace(/[^a-z0-9]/g, '');
  if (!slug) return '';
  // A handful of common non-.com TLDs worth trying first.
  for (const tld of ['.com', '.io', '.ai', '.app', '.dev', '.org']) {
    const host = slug + tld;
    if (BRAND_TLDS.has(tld)) return host;
  }
  return slug + '.com';
}

// Only trust `.com` for the guessed path: a guessed `.io` looks fine but is
// wrong far more often, and a wrong host just burns a failed image request.
const BRAND_TLDS = new Set(['.com']);

/** Candidate image URLs, best art first. */
export function logoSources(domain) {
  if (!domain || !HOST_RE.test(domain)) return [];
  return [
    // The service's own art is the highest-fidelity and always current.
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/apple-touch-icon-precomposed.png`,
    `https://${domain}/favicon.ico`,
    // Many sites only advertise their icon in <head> or block hotlinking at
    // the root path, so fall back to icon resolvers that have already crawled
    // the brand. Ordered: privacy-friendly first, largest art last.
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  ];
}

/** Deterministic monogram: 1–2 letters plus a stable hue. */
export function monogram(name) {
  const words = String(name || '?')
    .replace(/[^A-Za-z0-9 .-]/g, ' ')
    .split(/[\s.-]+/)
    .filter(Boolean);
  const letters = words.length > 1
    ? (words[0][0] + words[1][0])
    : String(words[0] || '?').slice(0, 2);
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  // Slightly desaturated pastels so the tile sits next to terracotta chrome.
  return { text: letters.toUpperCase(), hue: h, bg: `hsl(${h} 42% 46%)`, fg: '#fff' };
}

/** True when the row should render a role glyph instead of a brand icon. */
export function isRoleCard(id, type) {
  return type === 'plugin' || /^plugin-/.test(String(id || ''));
}

/** Glyph name for a role card. */
export function glyphFor(id, name) {
  const key = String(id || '');
  if (PLUGIN_GLYPH[key]) return PLUGIN_GLYPH[key];
  const n = String(name || '').toLowerCase();
  if (/research|analy|search|investig/.test(n)) return 'search';
  if (/code|develop|engineer|refactor/.test(n)) return 'code';
  if (/secur|compliance|audit|privacy/.test(n)) return 'shield';
  if (/data|chart|dashboard|statis|visual|sql/.test(n)) return 'chart';
  if (/writ|editor|copy|doc|contract|locali/.test(n)) return 'doc';
  if (/slide|deck|present/.test(n)) return 'slides';
  if (/sheet|spread|grid|bookkeep/.test(n)) return 'grid';
  if (/mail|email|outreach/.test(n)) return 'mail';
  if (/meet|note|planner|calendar|schedul/.test(n)) return 'calendar';
  if (/translat/.test(n)) return 'globe';
  if (/test|qa/.test(n)) return 'check';
  if (/devops|sysadmin|terminal|infra/.test(n)) return 'terminal';
  if (/api/.test(n)) return 'api';
  if (/teach|tutor|learn/.test(n)) return 'book';
  if (/recruit|people|human/.test(n)) return 'users';
  return 'spark';
}
