'use strict';
// Akron Bot — frame artifact type manifests.
//
// Desktop ships a manifest per frame artifact type (schemaVersion 1, contract
// 0.2.47) that declares the title, description, favicon/icon/tint, the
// capability set the frame may use, the feature flags that gate those
// capabilities, and the prod artifact slug. The two document types are
// `design` (a canvas of live artboards) and `slides` (a navigable deck).
//
// We keep the key names, descriptions, emoji and flag names byte-for-byte so a
// manifest written for Desktop reads the same here, and we compute an honest
// `enabled` verdict per capability against what this app actually implements
// (a capability that has no surface here reports `enabled: false` with a
// reason instead of pretending).
//
// Everything is pure: no Electron, no fs. Callers pass the current settings and
// the connected MCP servers in, so this is unit-testable in isolation.

const CONTRACT = '0.2.47';

// Verified against Claude.app frame type manifests (see rea-claude/artifact-types.md).
const TYPES = {
  design: {
    schemaVersion: 1,
    key: 'design',
    title: 'Design',
    description: 'Design canvas for websites, landing pages, screens, UI mockups, wireframes, posters, visual social posts, visuals, ads, invites and digital media: live artboards laid out on a canvas.',
    contract: CONTRACT,
    favicon: '\u{1F3A8}', // 🎨
    icon: 'Palette',
    tint: 'violet',
    capabilities: {
      downloads: {},
      artifact: {},
      comments: { composer_only: true, customAnchors: true },
      room: {},
      db: { rules: [{ path: '', write: 'admin' }] },
      assets: {},
      user: { scopes: ['profile'] },
      paste: {},
      flags: {
        keys: [
          'appifact_bottom_toolbar',
          'appifact_icon_set',
          'appifact_inspector_v1',
          'design_artboards_at_address',
          'design_bright_quilt',
          'design_cross_canvas_paste_confirm',
          'design_fixed_fade_wait',
          'design_index_read_first',
          'design_no_early_reads',
          'design_no_script_preload',
          'design_theme_tab',
          'tidal_glowing_ember',
        ],
      },
    },
    artifact: { prod: { slug: 'bcd2878f-a88d-4094-a616-8e39d8a5fd8a' } },
    aliases: ['canvas', 'artboard', 'artboards', 'wireframe', 'mockup', 'design-canvas'],
  },
  slides: {
    schemaVersion: 1,
    key: 'slides',
    title: 'Slides',
    description: 'Presentation decks: 16:9 or 4:3 slides to present, page through and download.',
    contract: CONTRACT,
    favicon: '\u{1F4FD}\uFE0F', // 📽️
    icon: 'Slides',
    tint: 'yellow',
    capabilities: {
      downloads: {},
      artifact: {},
      comments: { composer_only: true, customAnchors: true },
      room: {},
      db: { rules: [{ path: '', write: 'admin' }, { path: 'notes', read: 'admin', write: 'admin' }] },
      assets: {},
      user: { scopes: ['profile'] },
      mcp: { servers: [{ server: 'Google Drive', tools: ['create_file', 'gdrive_upload'] }] },
      flags: {
        keys: [
          'appifact_bottom_toolbar',
          'appifact_icon_set',
          'appifact_inspector_v1',
          'slides_no_early_reads',
          'slides_phone_remote',
          'slides_send_to_google_slides',
          'slides_source_decks',
          'slides_theme_tab',
          'tidal_glowing_ember',
        ],
      },
    },
    artifact: { prod: { slug: '3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61' } },
    aliases: ['deck', 'presentation', 'presentations', 'ppt', 'deck-canvas'],
  },
};

// Accent per tint name — used by the renderer for the artifact tab dot and the
// type badge. Kept here so the UI never hard-codes a colour per type.
const TINTS = {
  violet: { color: '#8b7bf5', ink: '#efeaff' },
  yellow: { color: '#e0b64a', ink: '#2a2313' },
  emerald: { color: '#10b981', ink: '#06211a' },
  green: { color: '#4f9a6a', ink: '#eaf7ef' },
};

// Which surface implements which capability, and how. `implemented` is a fact
// about this codebase, not about the ground truth manifest.
const CAPABILITY_SURFACES = {
  downloads: { implemented: true, note: 'Export HTML / MD, Save .html per artboard, Print to PDF' },
  artifact: { implemented: true, note: 'Opens in its own window, embeds in chat and in the Artifacts panel' },
  comments: { implemented: true, note: 'Composer-only pins with custom x/y anchors, persisted per artifact' },
  room: { implemented: false, note: 'collaboration rooms are not part of Akron Code' },
  db: { implemented: true, note: 'Edits persist locally under ~/.autobot/artifact-edits.json (local owner is admin)' },
  assets: { implemented: true, note: 'Artboard/slide HTML renders in a sandboxed iframe' },
  user: { implemented: true, note: 'local account profile (name + initials) is exposed to the frame' },
  paste: { implemented: false, note: 'cross-canvas paste is not implemented' },
  mcp: { implemented: true, note: 'Slides → Google Drive via a connected MCP server (create_file / gdrive_upload)' },
};

const norm = (language) => String(language == null ? '' : language).trim().toLowerCase();

// Deep copy so a caller that mutates a returned manifest cannot poison the
// registry for the next caller.
function clone(v) {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

/** Resolve an artifact language to its type key: 'design' | 'slides' | null. */
function keyFor(language) {
  const l = norm(language);
  if (!l) return null;
  if (TYPES[l]) return l;
  for (const key of Object.keys(TYPES)) {
    if ((TYPES[key].aliases || []).includes(l)) return key;
  }
  return null;
}

/**
 * Resolve every declared flag to a boolean. Desktop defaults each flag to its
 * prod value (all true in the manifest we mined); a local user may turn one off
 * in `~/.autobot/settings.json` under `flags`.
 */
function resolveFlags(key, overrides) {
  const t = TYPES[key];
  if (!t) return {};
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  const out = {};
  for (const name of t.capabilities.flags.keys) {
    out[name] = src[name] === undefined ? true : Boolean(src[name]);
  }
  return out;
}

/**
 * Decide whether the MCP capability is usable right now. `installed` is a list
 * of `{ name, tools: string[] }` for connected servers. A server entry from the
 * manifest is available when a connected server matches its name and exposes at
 * least one of the declared tools.
 */
function resolveMcp(declared, installed) {
  const servers = (declared && declared.servers) || [];
  const list = Array.isArray(installed) ? installed : [];
  // Compare loose names: "Google Drive", "google-drive" and "gdrive" style ids
  // all reduce to the same slug, so a server id is matched as well as a label.
  const slug = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  const resolved = servers.map((s) => {
    const target = slug(s.server);
    const hit = target && list.find((m) => {
      if (!m) return false;
      const name = slug(m.name);
      const id = slug(m.id);
      return (name && (name === target || name.includes(target))) || (id && (id === target || id.includes(target)));
    });
    const have = (hit && Array.isArray(hit.tools) ? hit.tools : []).map((x) => String(x));
    const matched = (s.tools || []).filter((t) => have.includes(t));
    return {
      server: s.server,
      tools: s.tools || [],
      connected: Boolean(hit),
      matched,
      available: Boolean(hit) && matched.length > 0,
    };
  });
  return { servers: resolved, available: resolved.some((s) => s.available) };
}

/**
 * Build the capability report for a type.
 * ctx: { flags, installed, profile }
 */
function resolveCapabilities(key, ctx) {
  const t = TYPES[key];
  if (!t) return null;
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const flags = resolveFlags(key, c.flags);
  const out = {};
  for (const name of Object.keys(t.capabilities)) {
    if (name === 'flags') continue;
    const surface = CAPABILITY_SURFACES[name] || { implemented: false, note: 'not implemented' };
    const declared = clone(t.capabilities[name]);
    const entry = { declared, implemented: Boolean(surface.implemented), note: surface.note, enabled: Boolean(surface.implemented) };
    if (name === 'mcp') {
      const mcp = resolveMcp(declared, c.installed);
      entry.servers = mcp.servers;
      entry.enabled = Boolean(surface.implemented) && mcp.available;
      if (!mcp.available) entry.reason = 'no connected server exposes the declared tools';
    }
    if (name === 'user') {
      const who = c.profile && typeof c.profile === 'object' ? c.profile : null;
      entry.profile = who ? { name: String(who.name || ''), avatar: String(who.avatar || '') } : null;
      entry.enabled = Boolean(who && (who.name || who.avatar));
      if (!entry.enabled) entry.reason = 'no local profile configured';
    }
    if (!entry.enabled && !entry.reason) entry.reason = surface.note;
    out[name] = entry;
  }
  return { flags, capabilities: out };
}

/** Full manifest: the ground-truth tree plus resolved flags/capabilities. */
function manifest(language, ctx) {
  const key = keyFor(language);
  if (!key) return null;
  const t = TYPES[key];
  const resolved = resolveCapabilities(key, ctx);
  const tint = TINTS[t.tint] || TINTS.emerald;
  return {
    schemaVersion: t.schemaVersion,
    key: t.key,
    title: t.title,
    description: t.description,
    contract: t.contract,
    favicon: t.favicon,
    icon: t.icon,
    tint: t.tint,
    tintColor: tint.color,
    tintInk: tint.ink,
    capabilities: clone(t.capabilities),
    resolved,
    artifact: clone(t.artifact),
  };
}

/**
 * The small shape the renderer needs for a tab / header: no capability report,
 * just identity plus the one flag that changes the surface.
 */
function uiMeta(language, ctx) {
  const m = manifest(language, ctx);
  if (!m) return null;
  return {
    key: m.key,
    title: m.title,
    description: m.description,
    favicon: m.favicon,
    icon: m.icon,
    tint: m.tint,
    tintColor: m.tintColor,
    tintInk: m.tintInk,
    contract: m.contract,
    slug: m.artifact && m.artifact.prod ? m.artifact.prod.slug : '',
    themeTab: Boolean(m.resolved.flags[`${m.key}_theme_tab`]),
    mcp: m.resolved.capabilities.mcp ? m.resolved.capabilities.mcp.servers : [],
  };
}

/** Window / document title for a canvas artifact: "Landing — Design". */
function windowTitle(language, name) {
  const m = uiMeta(language);
  const base = String(name == null ? '' : name).trim();
  if (!m) return base || 'Artifact';
  // A caller that only knows the frame type (the artifacts list passes the type
  // title when there is no label) would otherwise produce "Design — Design".
  if (!base || base.toLowerCase() === m.title.toLowerCase()) return m.title;
  return `${base} — ${m.title}`;
}

/**
 * The single title rule shared by a canvas document and its window/tab strip.
 * `name` is whatever the calling surface knows (often nothing), `parsedTitle`
 * is what the canvas builder derived from the content. A name that is merely
 * the frame type counts as no name, and a builder that already appended the
 * type title is stripped first, so "Design" + "Landing — Design" resolve to
 * "Landing — Design" rather than "Design — Design" or a bare "Design".
 */
function documentTitle(language, name, parsedTitle) {
  const m = uiMeta(language);
  const base = String(name == null ? '' : name).trim();
  const derived = String(parsedTitle == null ? '' : parsedTitle).trim();
  if (!m) return base || derived || 'Artifact';
  const strip = (s) => {
    const esc = m.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return String(s).replace(new RegExp('\\s*[—–-]\\s*' + esc + '$', 'i'), '').trim();
  };
  const given = base && base.toLowerCase() !== m.title.toLowerCase() ? base : '';
  const chosen = strip(given || derived);
  return chosen && chosen.toLowerCase() !== m.title.toLowerCase() ? `${chosen} — ${m.title}` : m.title;
}

/**
 * A data: URL favicon for the type emoji, so an artifact window shows 🎨 / 📽️
 * in its tab strip like Desktop does.
 */
function faviconDataUri(language) {
  const m = uiMeta(language);
  if (!m) return '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<text x="32" y="46" font-size="46" text-anchor="middle" font-family="Apple Color Emoji,'Segoe UI Emoji','Noto Color Emoji',sans-serif">${m.favicon}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** Convenience for the Artifact tool's own manifest (list of supported types). */
function list() {
  return Object.keys(TYPES).map((k) => {
    const t = TYPES[k];
    return { key: t.key, title: t.title, description: t.description, favicon: t.favicon, tint: t.tint, contract: t.contract };
  });
}

module.exports = {
  CONTRACT,
  TYPES,
  TINTS,
  CAPABILITY_SURFACES,
  keyFor,
  resolveFlags,
  resolveMcp,
  resolveCapabilities,
  manifest,
  uiMeta,
  windowTitle,
  documentTitle,
  faviconDataUri,
  list,
};
