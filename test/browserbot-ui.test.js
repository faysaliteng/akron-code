'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'resources', 'akron-browser-bot');
const { verifyBrandIntegrity } = require(path.join(ROOT, 'electron', 'brand-guard'));

async function run() {
  let pass = 0;
  function ok(label, cond, detail) {
    assert.ok(cond, `${label}${detail ? ': ' + detail : ''}`);
    pass++;
    console.log('  ok   - ' + label);
  }

  console.log('\nAkron Browser Bot UI & Brand Seal Verification');

  // 1. Extension shared/brand.js self-check
  const { checkBrand } = await import(pathToFileURL(path.join(EXT_DIR, 'shared', 'brand.js')).href);
  const extBrandProblems = await checkBrand({
    readText: async (rel) => fs.readFileSync(path.join(EXT_DIR, rel), 'utf8'),
    readBytes: async (rel) => fs.readFileSync(path.join(EXT_DIR, rel)),
  });
  ok('extension checkBrand() passes with 0 problems', extBrandProblems.length === 0, JSON.stringify(extBrandProblems));

  // 2. Desktop brand guard
  const deskBrand = verifyBrandIntegrity(ROOT);
  ok('verifyBrandIntegrity() passes', deskBrand.ok && deskBrand.checkedFiles >= 12, JSON.stringify(deskBrand));

  // 3. Zero legacy terracotta colors remain in sidepanel.css, look.css, options.css
  const forbidden = ['#d97757', '#c15f3c', '#e08a6d'];
  for (const rel of ['sidepanel/sidepanel.css', 'sidepanel/look.css', 'options/options.css']) {
    const css = fs.readFileSync(path.join(EXT_DIR, rel), 'utf8').toLowerCase();
    for (const hex of forbidden) {
      ok(`${rel} contains zero ${hex}`, !css.includes(hex));
    }
  }

  // 4. Inline plan card structure & update_plan dedup in sidepanel.js + sidepanel.html
  const html = fs.readFileSync(path.join(EXT_DIR, 'sidepanel', 'sidepanel.html'), 'utf8');
  const js = fs.readFileSync(path.join(EXT_DIR, 'sidepanel', 'sidepanel.js'), 'utf8');

  ok('floating #plan above messages is permanently hidden stub', html.includes('<div id="plan" class="hidden" aria-hidden="true">'));
  ok('sidepanel.html preserves <title>Akron Browser Bot</title> & akronlogic.com', html.includes('<title>Akron Browser Bot</title>') && html.includes('akronlogic.com'));
  ok('sidepanel.html includes #active-tab-pill, #snap-tab-btn, #grab-selection-btn', html.includes('id="active-tab-pill"') && html.includes('id="snap-tab-btn"') && html.includes('id="grab-selection-btn"'));
  ok('sidepanel.js renders .live-plan-card inline inside #messages', js.includes('cardEl.className = "live-plan-card"') && js.includes('addToChat(cardEl)'));
  ok('sidepanel.js suppresses duplicate update_plan step card', js.includes('if (name === "update_plan")') && js.includes('planToolIds.add(id)'));
  ok('updateGifButton preserves #gif-btn icon via #gif-btn-label', js.includes('$("gif-btn-label")') && !js.includes('btn.textContent = gifBusy'));

  console.log(`\nALL CHECKS PASSED (${pass})\n`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
