'use strict';
// Design + Slides canvas artifact types: contract parsing and document build.
// Pure Node — no Electron, no network.
const assert = require('assert');
const c = require('../electron/artifactcanvas');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};

console.log('\nartifactcanvas — design');

const design = c.parseDesign(JSON.stringify({
  title: 'Checkout redesign',
  artboards: [
    { name: 'Mobile', width: 390, height: 844, html: '<h1>Cart</h1>', notes: 'baseline' },
    { name: 'Desktop', html: '<h1>Wide</h1>' },
  ],
}));
ok('title parsed', design.title === 'Checkout redesign', design.title);
ok('two artboards', design.artboards.length === 2, design.artboards.length);
ok('name preserved', design.artboards[0].name === 'Mobile');
ok('size clamped/kept', design.artboards[0].width === 390 && design.artboards[0].height === 844);
ok('fluid board gets 0 size', design.artboards[1].width === 0 && design.artboards[1].height === 0);
ok('notes preserved', design.artboards[0].notes === 'baseline');

const fenced = c.parseDesign('Here you go:\n```json\n{"artboards":[{"name":"A","html":"<b>x</b>"}]}\n```');
ok('json inside a code fence parses', fenced.artboards.length === 1 && fenced.artboards[0].name === 'A');

const split = c.parseDesign('<p>one</p>\n---\n<p>two</p>\n---\n<p>three</p>');
ok('--- sections become artboards', split.artboards.length === 3, split.artboards.length);
ok('sections auto-named', split.artboards[2].name === 'Artboard 3', split.artboards[2].name);

const bare = c.parseDesign('<p>just one</p>');
ok('single html blob → one artboard', bare.artboards.length === 1);

const arr = c.parseDesign('[{ "name": "Only", "html": "<i>i</i>" }]');
ok('bare JSON array accepted', arr.artboards.length === 1 && arr.artboards[0].name === 'Only');

const junk = c.parseDesign('{ not json at all ');
ok('garbage degrades to one artboard', junk.artboards.length === 1 && junk.artboards[0].html.includes('not json'));

const clamped = c.parseDesign(JSON.stringify({ artboards: [{ name: 'Big', width: 99999, height: 10, html: '' }] }));
ok('width clamped to 2400', clamped.artboards[0].width === 2400, clamped.artboards[0].width);
ok('height clamped to min 120', clamped.artboards[0].height === 120, clamped.artboards[0].height);

const dBytes = c.designHtml('Site', JSON.stringify({ title: 'Site', artboards: [{ name: 'A', width: 390, height: 844, html: '<h1>hi</h1>' }] }));
ok('design document is a full page', dBytes.startsWith('<!doctype html>') && dBytes.includes('</html>'));
ok('design renders artboards in iframes', (dBytes.match(/<iframe/g) || []).length >= 1);
ok('design rail lists artboards', dBytes.includes('railitem') && dBytes.includes('>A<'));
ok('design has print + save controls', dBytes.includes('data-act="print"') && dBytes.includes('data-act="save"'));
ok('design zoom overlay present', dBytes.includes('id="zoom"') && dBytes.includes('data-act="zoom"'));
ok('artboard html is escaped into srcdoc (no tag injection)', dBytes.includes('srcdoc="&lt;h1&gt;hi&lt;/h1&gt;"'));
ok('embedded board JSON escapes </script> risk', !/<script[^>]*>[^]*?<\/script>\s*<\/script>/.test(dBytes));

console.log('\nartifactcanvas — slides');

const deck = c.parseSlides(JSON.stringify({
  title: 'Q3',
  slides: [
    { title: 'Intro', html: '<p>hello</p>', notes: 'welcome' },
    { title: 'Numbers', bullets: ['up 20%', 'churn 1%'] },
  ],
}));
ok('two slides', deck.slides.length === 2);
ok('title parsed', deck.title === 'Q3');
ok('html body kept', deck.slides[0].html === '<p>hello</p>');
ok('speaker notes kept', deck.slides[0].notes === 'welcome');
ok('bullets become a list', deck.slides[1].html === '<ul><li>up 20%</li><li>churn 1%</li></ul>', deck.slides[1].html);

const md = c.parseSlides('# One\nthe first\n\n---\n\n# Two\n- a\n- b');
ok('markdown deck splits on ---', md.slides.length === 2, md.slides.length);
ok('heading becomes the slide title', md.slides[0].title === 'One', md.slides[0].title);
ok('markdown body rendered', md.slides[0].html.includes('<p>the first</p>'), md.slides[0].html);
ok('markdown bullets rendered', (md.slides[1].html.match(/<li>/g) || []).length === 2, md.slides[1].html);

const plainBody = c.parseSlides(JSON.stringify({ slides: [{ title: 'T', html: 'just words, no tags' }] }));
ok('tag-less string body is treated as markdown', plainBody.slides[0].html.includes('<p>just words, no tags</p>'), plainBody.slides[0].html);

const sBytes = c.slidesHtml('Deck', '# A\nx\n\n---\n# B\ny');
ok('deck document is a full page', sBytes.startsWith('<!doctype html>') && sBytes.includes('</html>'));
ok('every slide is a section', (sBytes.match(/<section class="slide(?: active)?"/g) || []).length === 2);
ok('keyboard navigation wired', sBytes.includes("ev.key === 'ArrowRight'") && sBytes.includes("ev.key === 'ArrowLeft'"));
ok('progress + counter present', sBytes.includes('id="prog"') && sBytes.includes('id="count"'));
ok('notes toggle present', sBytes.includes('data-act="notes"') && sBytes.includes('.nopnotes .snotes'));
ok('present (fullscreen) control', sBytes.includes('data-act="full"') && sBytes.includes('requestFullscreen'));
ok('print stylesheet emits one slide per page', sBytes.includes('@media print') && sBytes.includes('page-break-after:always'));

console.log('\nartifactcanvas — routing');

ok('design routes to the canvas builder', c.isCanvas('design') && c.isCanvas('Design '));
ok('slides routes to the deck builder', c.isCanvas('slides') && c.isCanvas('deck') && c.isCanvas('presentation'));
ok('html does not route to a canvas', !c.isCanvas('html') && !c.isCanvas('markdown') && !c.isCanvas(''));
ok('canvasHtml returns null for plain languages', c.canvasHtml('html', 'x', '<p>y</p>') === null);
ok('canvasHtml builds design docs', String(c.canvasHtml('design', 'D', '<p>x</p>')).includes('class="canvas layout-grid"'));
ok('canvasHtml builds deck docs', String(c.canvasHtml('slides', 'S', '# A\nx')).includes('class="slide active"'));

ok('mdToHtml escapes html entities', c.mdToHtml('<img onerror=x> **b**') === '<p>&lt;img onerror=x&gt; <strong>b</strong></p>', c.mdToHtml('<img onerror=x> **b**'));

console.log('\nartifactcanvas — interactive design');

const dLive = c.designHtml('D', JSON.stringify({
  title: 'Studio',
  artboards: [{ name: 'A', html: '<h1>a</h1>', width: 390, height: 844 }, { name: 'B', html: '<h1>b</h1>' }],
}));
ok('runtime is embedded, not a static script', dLive.includes('function designRuntime'), dLive.slice(0, 60));
ok('no legacy static BOARDS array', !dLive.includes('const BOARDS ='));
ok('runtime is self-contained', !/require\(|module\.exports/.test(dLive.slice(dLive.indexOf('function designRuntime'), dLive.indexOf('</script>'))));
ok('artboard name is editable inline', dLive.includes('data-edit="name"'));
ok('device presets offered', dLive.includes('data-sel="device"') && dLive.includes('1440x900'));
ok('reorder controls', dLive.includes('data-act="up"') && dLive.includes('data-act="down"'));
ok('add / duplicate / delete controls', dLive.includes('data-act="add"') && dLive.includes('data-act="dup"') && dLive.includes('data-act="del"'));
ok('html source drawer', dLive.includes('id="drawer"') && dLive.includes('data-act="apply-src"'));
ok('layout switch', dLive.includes('data-l="row"') && dLive.includes('data-l="column"'));
ok('zoom controls', dLive.includes('data-act="zoom-in"') && dLive.includes('data-act="zoom-out"') && dLive.includes('id="zlbl"'));
ok('comment mode + pin layer', dLive.includes('data-act="comment-mode"') && dLive.includes('class="pins"'));
ok('design payload entity-escapes markup', dLive.includes('\\u003c'));

const dEdited = c.designHtml('D', JSON.stringify({
  title: 'Studio',
  artboards: [{ name: 'A', html: '<h1>a</h1>' }],
}), {
  title: '  Renamed  ',
  layout: 'row',
  zoom: 1.4,
  boards: [{ name: 'Only', html: '<b>x</b>', width: 768, height: 1024 }],
  comments: [{ i: 0, x: 12.5, y: 88, text: 'align this' }],
});
ok('edit title wins', dEdited.includes('>Renamed<'));
ok('edit layout applied', dEdited.includes('class="canvas layout-row"'));
ok('edit zoom applied', dEdited.includes('zoom:1.4'));
ok('edited board list replaces parsed artboards', dEdited.includes('>Only<') && !dEdited.includes('>A<'));
ok('comment pin rendered', dEdited.includes('class="pin"') && dEdited.includes('align this'));

const dBad = c.designHtml('D', '{"title":"T","artboards":[{"name":"A","html":"x"}]}', {
  layout: 'nonsense', zoom: 99, boards: [{ name: 'Z', html: 'z', width: -5, height: 'no' }],
  comments: [{ i: 9, x: 500, y: -20, text: 'far' }, { text: '' }],
});
ok('bad layout falls back to grid', dBad.includes('class="canvas layout-grid"'));
ok('zoom is clamped', dBad.includes('zoom:2') && !dBad.includes('zoom:99'));
ok('board width clamps negative to fluid', dBad.includes('>fluid<'));
ok('absent size stays fluid, not 120px', dBad.includes('width:100%') && !dBad.includes('width:120px'));
ok('comment index clamps into the board range', (dBad.match(/title="far"/g) || []).length === 1);
ok('comment coordinates clamp to 0–100', dBad.includes('left:100%;top:0%'));
ok('empty comment text is dropped', !dBad.includes('<b></b>'));

console.log('\nartifactcanvas — interactive slides');

const sBytes2 = c.slidesHtml('S', JSON.stringify({
  title: 'Q3', slides: [{ title: 'One', html: '<ul><li>x</li></ul>' }, { title: 'Two', html: '<p>y</p>' }],
}));
ok('slides runtime embedded', sBytes2.includes('function slidesRuntime'));
ok('thumbnail rail', sBytes2.includes('id="thumbs"') && sBytes2.includes('class="thumb on"'));
ok('edit mode control', sBytes2.includes('data-act="edit"'));
ok('aspect toggle', sBytes2.includes('data-act="aspect"'));
ok('slide add / dup / del / reorder', sBytes2.includes('data-act="add"') && sBytes2.includes('data-act="dup"') && sBytes2.includes('data-act="del"') && sBytes2.includes('data-act="up"') && sBytes2.includes('data-act="down"'));
ok('export html + markdown', sBytes2.includes('data-act="html"') && sBytes2.includes('data-act="md"'));
ok('save to drive control', sBytes2.includes('data-act="drive"'));
ok('editable title + notes', sBytes2.includes('id="ttl"') && sBytes2.includes('class="snotes"'));
ok('slides open in edit mode', sBytes2.includes('var editing = true;'));
ok('inline edits autosave on blur', sBytes2.includes("getAttribute('data-edit')") || sBytes2.includes("addEventListener('focusout'"));
ok('deck title blur is collected', sBytes2.includes("t.id === 'ttl'") && sBytes2.includes('TITLE = tv'));
ok('slides payload entity-escapes markup', sBytes2.includes('\\u003c'));

const sEdited = c.slidesHtml('S', JSON.stringify({ title: 'Q3', slides: [{ title: 'One', html: '<p>x</p>' }] }), {
  title: 'Edited deck',
  aspect: '4:3',
  slides: [{ title: 'Fresh', html: '<p>new</p>', notes: 'say it' }],
});
ok('edit deck title wins', sEdited.includes('>Edited deck<'));
ok('edit aspect applied', sEdited.includes('class="aspect-43"'));
ok('edited slides replace parsed deck', sEdited.includes('>Fresh<') && !sEdited.includes('>One<'));
ok('edited notes kept', sEdited.includes('say it'));

const sBad = c.slidesHtml('S', '{"title":"T","slides":[{"title":"A","html":"a"}]}', {
  aspect: 'banana', slides: [{ title: 'Z' }],
});
ok('bad aspect falls back to 16:9', sBad.includes('class="aspect-169"'));
ok('slide with no body survives', sBad.includes('>Z<'));

console.log('\nartifactcanvas — edit merge helpers');

const base = c.parseDesign(JSON.stringify({ title: 'Base', artboards: [{ name: 'A', html: 'a' }] }));
ok('applyDesignEdits with no edits returns base', c.applyDesignEdits(base, undefined).artboards.length === 1);
ok('applyDesignEdits ignores an empty boards array', c.applyDesignEdits(base, { boards: [] }).artboards[0].name === 'A');
ok('applySlidesEdits normalizes html to a string', typeof c.applySlidesEdits({ title: 'x', slides: [{ title: 'y' }] }, { slides: [{ title: 'z', html: null }] }).slides[0].html === 'string');


console.log('\n' + (process.exitCode ? 'FAILED' : 'PASSED') + ' (' + pass + ' checks)');
