'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');

function loadCjsFromEsmFile(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const code = transformSync(raw, {
    loader: relPath.endsWith('.jsx') ? 'jsx' : 'js',
    format: 'cjs',
    jsx: 'transform',
    sourcefile: relPath,
  }).code;
  const mod = { exports: {} };
  const stubs = {
    react: {
      default: { createElement: () => ({}) },
      createElement: () => ({}),
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
    },
    'react-dom': {},
    'marked': { marked: { parse: (s) => s, Renderer: function Renderer() {}, use: () => {} } },
    'dompurify': { default: { sanitize: (s) => s } },
    'highlight.js': { default: { highlightElement: () => {} } },
  };
  const customRequire = (id) => {
    if (stubs[id]) return stubs[id];
    if (id === 'lucide-react' || id.startsWith('./') || id.startsWith('../')) return new Proxy({}, { get: (_t, p) => () => ({ type: p }) });
    return require(id);
  };
  const fn = new Function('require', 'module', 'exports', '__filename', '__dirname', code);
  fn(customRequire, mod, mod.exports, fullPath, path.dirname(fullPath));
  return mod.exports;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    failed++;
  }
}

console.log('\n=== TIMESTAMPS, COMPACT ACTION BAR, APPEARANCE STUDIO & DOCS IMAGE TESTS ===');

const helpers = loadCjsFromEsmFile('src/utils/appHelpers.jsx');
const extPanels = loadCjsFromEsmFile('src/components/settings/ExtendedSettingsPanels.jsx');

test('fmtMessageTimestamp formats date-time, short, 12h, relative, iso, prior year & invalid safely', () => {
  const { fmtMessageTimestamp, fmtMessageFullTimestamp } = helpers;
  assert.strictEqual(typeof fmtMessageTimestamp, 'function');
  assert.strictEqual(typeof fmtMessageFullTimestamp, 'function');

  assert.strictEqual(fmtMessageTimestamp(0), '');
  assert.strictEqual(fmtMessageTimestamp(null), '');
  assert.strictEqual(fmtMessageTimestamp('bad'), '');
  assert.strictEqual(fmtMessageFullTimestamp(0), '');

  const nowTs = Date.now() - 10 * 1000;
  const dtToday = fmtMessageTimestamp(nowTs, 'date-time');
  assert.ok(dtToday.startsWith('Today · '), `Expected Today prefix, got: ${dtToday}`);
  assert.strictEqual(fmtMessageTimestamp(nowTs, 'short'), dtToday);

  const f12 = fmtMessageTimestamp(nowTs, '12h');
  assert.ok(/\b(AM|PM)$/.test(f12) && f12.includes(' · '), `Expected 12h AM/PM format, got: ${f12}`);

  const fRel = fmtMessageTimestamp(nowTs, 'relative');
  assert.ok(fRel.startsWith('just now · '), `Expected relative just now, got: ${fRel}`);

  const fiveMin = Date.now() - 5 * 60 * 1000;
  assert.ok(fmtMessageTimestamp(fiveMin, 'relative').startsWith('5m ago · '));

  const fixed = new Date(2024, 10, 27, 14, 5, 9).getTime();
  assert.strictEqual(fmtMessageTimestamp(fixed, 'iso'), '2024-11-27 14:05:09');
  const priorYear = fmtMessageTimestamp(fixed, 'date-time');
  assert.ok(priorYear.includes('2024') && priorYear.includes('14:05'), `Expected year in ${priorYear}`);
  assert.ok(fmtMessageFullTimestamp(fixed).length > 8);
});

test('computeAppearanceVars maps dark/light/auto, accent hex, surfaces, density, width, style & radius', () => {
  const { ACCENT_PRESETS, DEFAULT_APPEARANCE_SETTINGS, computeAppearanceVars } = extPanels;
  assert.ok(Array.isArray(ACCENT_PRESETS) && ACCENT_PRESETS.length >= 6);
  assert.strictEqual(DEFAULT_APPEARANCE_SETTINGS.theme, 'dark');
  assert.strictEqual(DEFAULT_APPEARANCE_SETTINGS.showTimestamps, true);
  assert.strictEqual(DEFAULT_APPEARANCE_SETTINGS.showFloatingToolbar, false);

  const autoLight = computeAppearanceVars({ ...DEFAULT_APPEARANCE_SETTINGS, theme: 'auto' }, true);
  assert.strictEqual(autoLight.theme, 'light');
  const autoDark = computeAppearanceVars({ ...DEFAULT_APPEARANCE_SETTINGS, theme: 'auto' }, false);
  assert.strictEqual(autoDark.theme, 'dark');

  const custom = computeAppearanceVars({
    theme: 'dark',
    surfaceFinish: 'midnight-glass',
    accentColor: '#3b82f6',
    bgPattern: 'ambient-glow',
    uiDensity: 'compact',
    chatWidth: 'wide',
    messageStyle: 'bubbles',
    borderRadius: 'rounded',
  }, false);

  assert.strictEqual(custom.surface, 'midnight-glass');
  assert.strictEqual(custom.bgPattern, 'ambient-glow');
  assert.strictEqual(custom.density, 'compact');
  assert.strictEqual(custom.chatWidth, 'wide');
  assert.strictEqual(custom.msgStyle, 'bubbles');
  assert.strictEqual(custom.borderRadius, 'rounded');
  assert.strictEqual(custom.style['--accent'], '#3b82f6');
  assert.ok(custom.style['--accent-soft'].includes('59, 130, 246'));
  assert.strictEqual(custom.style['--chat-max-w'], '1080px');
  assert.strictEqual(custom.style['--radius-md'], '12px');
  assert.strictEqual(custom.style['--radius-card'], '16px');
  assert.strictEqual(custom.style['--radius-composer'], '18px');

  const defaults = computeAppearanceVars({}, false);
  assert.strictEqual(defaults.chatAlign, 'centered');
  assert.strictEqual(defaults.userPromptAlign, 'antigravity');
  assert.strictEqual(defaults.style['--chat-max-w'], '768px');
  assert.strictEqual(defaults.style['--output-max-w'], '768px');
  assert.strictEqual(defaults.style['--chat-side-pad'], '64px');
  assert.strictEqual(defaults.style['--output-body-pad-x'], '12px');
  assert.strictEqual(defaults.style['--chat-margin-l'], 'auto');

  const layoutCustom = computeAppearanceVars({
    chatWidth: 'custom',
    chatCustomWidth: 1040,
    outputWidthMode: 'custom',
    outputCustomWidth: 1120,
    chatSidePadding: 52,
    outputSidePadding: 18,
    chatAlignment: 'left',
    userPromptAlign: 'left',
    messageGap: 22,
    codeBlockMaxHeight: 520,
  }, false);
  assert.strictEqual(layoutCustom.chatAlign, 'left');
  assert.strictEqual(layoutCustom.userPromptAlign, 'left');
  assert.strictEqual(layoutCustom.style['--chat-max-w'], '1040px');
  assert.strictEqual(layoutCustom.style['--output-max-w'], '1120px');
  assert.strictEqual(layoutCustom.style['--chat-side-pad'], '52px');
  assert.strictEqual(layoutCustom.style['--output-body-pad-x'], '18px');
  assert.strictEqual(layoutCustom.style['--chat-margin-l'], '0px');
  assert.strictEqual(layoutCustom.style['--msg-pad-y'], '22px');
  assert.strictEqual(layoutCustom.style['--code-max-h'], '520px');
});

test('App.jsx & styles.css wire compact 11px action bar, user footer timestamps & overlap fix', () => {
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
  const ecCss = fs.readFileSync(path.join(ROOT, 'src/styles/emerald-carbon.css'), 'utf8');
  const extSrc = fs.readFileSync(path.join(ROOT, 'src/components/settings/ExtendedSettingsPanels.jsx'), 'utf8');

  assert.ok(appSrc.includes('fmtMessageTimestamp(m.ts, tsFormat)'));
  assert.ok(appSrc.includes('className="msg-user-footer"'));
  assert.ok(appSrc.includes("className={'response-actions style-' + actionBarStyle}"));
  assert.ok(appSrc.includes('<Icon name="GitBranch" size={11} />'));
  assert.ok(appSrc.includes('<Icon name="History" size={11} />'));
  assert.ok(appSrc.includes('<Icon name="Share" size={11} />'));
  assert.ok(appSrc.includes('{showFloatingToolbar && ('));

  assert.ok(/\.response-action-btn\s*\{[^}]*padding:\s*2px 6px[^}]*font-size:\s*11px/s.test(cssSrc), 'Expected compact 11px .response-action-btn');
  assert.ok(cssSrc.includes('.msg-user-footer'));
  assert.ok(cssSrc.includes('.msg-timestamp'));
  assert.ok(ecCss.includes('[data-surface=\'matte-obsidian\']') || ecCss.includes('[data-surface="matte-obsidian"]'));
  assert.ok(ecCss.includes('midnight-glass') && ecCss.includes('minimal-slate'));
  assert.ok(extSrc.includes('Reset Appearance to Default'));
});

test('README.md and docs/*.md have 100% valid existing images (>5KB for PNG screenshots) and zero broken local paths', () => {
  const mdFiles = [
    path.join(ROOT, 'README.md'),
    ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join(ROOT, 'docs', f)),
  ];

  const mdImgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  const htmlImgRe = /<img\s+[^>]*src=["']([^"']+)["']/gi;
  let checkedImgs = 0;

  for (const mdPath of mdFiles) {
    const content = fs.readFileSync(mdPath, 'utf8');
    const dir = path.dirname(mdPath);
    for (const re of [mdImgRe, htmlImgRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content))) {
        const src = String(m[1] || '').trim().split(/\s+/)[0];
        if (!src || /^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;
        checkedImgs++;
        const resolved = path.resolve(dir, src);
        assert.ok(fs.existsSync(resolved), `Missing image referenced in ${path.relative(ROOT, mdPath)}: ${src}`);
        const st = fs.statSync(resolved);
        if (src.endsWith('.png')) {
          assert.ok(st.size > 5120, `Screenshot PNG too small (${st.size} bytes): ${src}`);
        } else {
          assert.ok(st.size > 100, `Asset too small (${st.size} bytes): ${src}`);
        }
      }
    }
  }
  assert.ok(checkedImgs >= 15, `Expected at least 15 verified local images in README/docs, found ${checkedImgs}`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'screenshots')), 'Stale top-level screenshots/ folder must remain deleted');
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs/screenshots/windows11-akron-code.png')), 'Flawed windows11 screenshot must remain deleted');
});

if (failed > 0) {
  console.error(`\nFAILED: ${failed} tests failed (${passed} passed)`);
  process.exit(1);
}
console.log(`\nALL_APPEARANCE_TIMESTAMPS_TESTS_PASSED (${passed}/${passed})`);
