'use strict';
// Tests for the frame artifact type manifests (electron/artifacttypes.js).
//
// The ground truth is `rea-claude/artifact-types.md` (Claude.app 7.x): two
// document types, `design` and `slides`, each with schemaVersion 1, contract
// 0.2.47, an emoji favicon, a named icon, a tint, a capability tree, a flag
// list and a prod slug. These tests pin the mined values so a refactor cannot
// silently drop a capability or a flag.

const t = require('../electron/artifacttypes');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// ── identity: exact mined values ─────────────────────────────────────────────
const design = t.manifest('design', {});
ok('design schemaVersion 1', design.schemaVersion === 1);
ok('design key', design.key === 'design');
ok('design title', design.title === 'Design');
ok('design contract 0.2.47', design.contract === '0.2.47');
ok('design favicon 🎨', design.favicon === '\u{1F3A8}');
ok('design icon Palette', design.icon === 'Palette');
ok('design tint violet', design.tint === 'violet');
ok('design slug', design.artifact.prod.slug === 'bcd2878f-a88d-4094-a616-8e39d8a5fd8a');
ok('design description mentions live artboards', /live artboards laid out on a canvas/.test(design.description));
ok('design flags: 12 keys', design.capabilities.flags.keys.length === 12);
ok('design flag design_theme_tab', design.capabilities.flags.keys.includes('design_theme_tab'));
ok('design db rule write admin', design.capabilities.db.rules[0].write === 'admin');
ok('design comments composer_only', design.capabilities.comments.composer_only === true);
ok('design comments customAnchors', design.capabilities.comments.customAnchors === true);
ok('design user scope profile', design.capabilities.user.scopes.includes('profile'));
ok('design has no mcp capability', design.capabilities.mcp === undefined);

const slides = t.manifest('slides', {});
ok('slides favicon 📽️', slides.favicon === '\u{1F4FD}\uFE0F');
ok('slides icon Slides', slides.icon === 'Slides');
ok('slides tint yellow', slides.tint === 'yellow');
ok('slides slug', slides.artifact.prod.slug === '3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61');
ok('slides description 16:9 or 4:3', /16:9 or 4:3/.test(slides.description));
ok('slides flags: 9 keys', slides.capabilities.flags.keys.length === 9);
ok('slides flag send_to_google_slides', slides.capabilities.flags.keys.includes('slides_send_to_google_slides'));
ok('slides db notes rule read admin', slides.capabilities.db.rules.some((r) => r.path === 'notes' && r.read === 'admin'));
ok('slides mcp server Google Drive', slides.capabilities.mcp.servers[0].server === 'Google Drive');
ok('slides mcp tools', slides.capabilities.mcp.servers[0].tools.join(',') === 'create_file,gdrive_upload');

// ── language resolution + aliases ────────────────────────────────────────────
ok('keyFor design', t.keyFor('design') === 'design');
ok('keyFor Design (case)', t.keyFor('  Design ') === 'design');
ok('alias canvas → design', t.keyFor('canvas') === 'design');
ok('alias artboard → design', t.keyFor('artboard') === 'design');
ok('alias deck → slides', t.keyFor('deck') === 'slides');
ok('alias presentation → slides', t.keyFor('presentation') === 'slides');
ok('non-canvas → null', t.keyFor('html') === null);
ok('empty → null', t.keyFor('') === null);
ok('manifest for unknown → null', t.manifest('javascript', {}) === null);

// ── flags: default on, local override off ────────────────────────────────────
const f1 = t.resolveFlags('design', {});
ok('flags default true', Object.values(f1).every((v) => v === true));
const f2 = t.resolveFlags('design', { design_theme_tab: false });
ok('flags override off', f2.design_theme_tab === false);
ok('flags leave others on', f2.design_bright_quilt === true);
const f3 = t.resolveFlags('design', { not_a_flag: false });
ok('unknown flags ignored', !('not_a_flag' in f3));
ok('resolveFlags unknown type → {}', Object.keys(t.resolveFlags('nope', {})).length === 0);

// ── capabilities: honest implemented verdicts ────────────────────────────────
const rc = t.resolveCapabilities('design', {});
ok('downloads enabled', rc.capabilities.downloads.enabled === true);
ok('artifact enabled', rc.capabilities.artifact.enabled === true);
ok('comments enabled', rc.capabilities.comments.enabled === true);
ok('assets enabled', rc.capabilities.assets.enabled === true);
ok('db enabled', rc.capabilities.db.enabled === true);
ok('room not implemented', rc.capabilities.room.enabled === false && /not part of Helio/.test(rc.capabilities.room.reason));
ok('paste not implemented', rc.capabilities.paste.enabled === false);
ok('user needs a profile', rc.capabilities.user.enabled === false);

const rcUser = t.resolveCapabilities('design', { profile: { name: 'Saimon' } });
ok('user enabled with a profile', rcUser.capabilities.user.enabled === true);
ok('user profile surfaced', rcUser.capabilities.user.profile.name === 'Saimon');
ok('user scope profile kept', rcUser.capabilities.user.declared.scopes.includes('profile'));

// ── mcp capability: needs a connected server exposing a declared tool ────────
const mcpNone = t.resolveCapabilities('slides', {});
ok('mcp off with no servers', mcpNone.capabilities.mcp.enabled === false);
ok('mcp reason present', /no connected server/.test(mcpNone.capabilities.mcp.reason || ''));
ok('mcp entry not connected', mcpNone.capabilities.mcp.servers[0].connected === false);

const mcpPartial = t.resolveCapabilities('slides', { installed: [{ name: 'Google Drive', tools: ['search_files', 'read_file'] }] });
ok('mcp partial: connected but no declared tool', mcpPartial.capabilities.mcp.servers[0].connected === true);
ok('mcp partial: still disabled', mcpPartial.capabilities.mcp.enabled === false);

const mcpOk = t.resolveCapabilities('slides', { installed: [{ name: 'Google Drive', tools: ['create_file', 'gdrive_upload'] }] });
ok('mcp ok: enabled', mcpOk.capabilities.mcp.enabled === true);
ok('mcp ok: matched tools', mcpOk.capabilities.mcp.servers[0].matched.join(',') === 'create_file,gdrive_upload');

const mcpId = t.resolveCapabilities('slides', { installed: [{ id: 'google-drive', name: '', tools: ['gdrive_upload'] }] });
ok('mcp matches by id too', mcpId.capabilities.mcp.enabled === true);

// ── uiMeta: what the renderer consumes ──────────────────────────────────────
const ui = t.uiMeta('design', {});
ok('uiMeta key', ui.key === 'design');
ok('uiMeta favicon', ui.favicon === '\u{1F3A8}');
ok('uiMeta tint colour', /^#[0-9a-f]{6}$/i.test(ui.tintColor));
ok('uiMeta themeTab on', ui.themeTab === true);
const uiOff = t.uiMeta('design', { flags: { design_theme_tab: false } });
ok('uiMeta themeTab off', uiOff.themeTab === false);
ok('uiMeta null for html', t.uiMeta('html', {}) === null);

// ── window title + favicon data URL ────────────────────────────────────────
ok('windowTitle with name', t.windowTitle('design', 'Landing') === 'Landing — Design');
ok('windowTitle empty name', t.windowTitle('slides', '') === 'Slides');
ok('windowTitle non-canvas', t.windowTitle('html', 'page.html') === 'page.html');
const fav = t.faviconDataUri('design');
ok('faviconDataUri svg', /^data:image\/svg\+xml/.test(fav));
ok('faviconDataUri carries the emoji', decodeURIComponent(fav).includes('\u{1F3A8}'));
ok('faviconDataUri empty for html', t.faviconDataUri('html') === '');

// documentTitle: the one rule shared by the canvas document and the window tab.
ok('documentTitle prefers parsed name', t.documentTitle('design', '', 'Landing — Design') === 'Landing — Design');
ok('documentTitle treats a type name as no name', t.documentTitle('design', 'Design', 'Landing — Design') === 'Landing — Design');
ok('documentTitle names a caller label', t.documentTitle('slides', 'Q3 deck', '') === 'Q3 deck — Slides');
ok('documentTitle strips a duplicated type suffix', t.documentTitle('slides', 'Q3 deck — Slides', '') === 'Q3 deck — Slides');
ok('documentTitle falls back to the type title', t.documentTitle('slides', '', '') === 'Slides');
ok('documentTitle is type-name safe for unknown types', t.documentTitle('html', 'page.html', '') === 'page.html');

// ── list() ──────────────────────────────────────────────────────────────────
const all = t.list();
ok('list has 2 types', all.length === 2);
ok('list titles', all.map((x) => x.title).sort().join(',') === 'Design,Slides');
ok('list keeps favicon', all.every((x) => x.favicon && x.contract === '0.2.47'));

// ── purity: mutating a returned manifest must not poison the registry ───────
const m1 = t.manifest('design', {});
m1.capabilities.flags.keys.push('bogus');
m1.title = 'Hacked';
const m2 = t.manifest('design', {});
ok('registry not poisoned by title edit', m2.title === 'Design');
ok('registry not poisoned by flag edit', !m2.capabilities.flags.keys.includes('bogus'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
