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
ok('every slide is a section', (sBytes.match(/<section class="slide">/g) || []).length === 2);
ok('keyboard navigation wired', sBytes.includes("e.key === 'ArrowRight'") && sBytes.includes("e.key === 'ArrowLeft'"));
ok('progress + counter present', sBytes.includes('id="prog"') && sBytes.includes('id="count"'));
ok('notes toggle present', sBytes.includes('data-act="notes"') && sBytes.includes('.nopnotes .snotes'));
ok('present (fullscreen) control', sBytes.includes('data-act="full"') && sBytes.includes('requestFullscreen'));
ok('print stylesheet emits one slide per page', sBytes.includes('@media print') && sBytes.includes('page-break-after:always'));

console.log('\nartifactcanvas — routing');

ok('design routes to the canvas builder', c.isCanvas('design') && c.isCanvas('Design '));
ok('slides routes to the deck builder', c.isCanvas('slides') && c.isCanvas('deck') && c.isCanvas('presentation'));
ok('html does not route to a canvas', !c.isCanvas('html') && !c.isCanvas('markdown') && !c.isCanvas(''));
ok('canvasHtml returns null for plain languages', c.canvasHtml('html', 'x', '<p>y</p>') === null);
ok('canvasHtml builds design docs', String(c.canvasHtml('design', 'D', '<p>x</p>')).includes('class="canvas"'));
ok('canvasHtml builds deck docs', String(c.canvasHtml('slides', 'S', '# A\nx')).includes('class="slide"'));

ok('mdToHtml escapes html entities', c.mdToHtml('<img onerror=x> **b**') === '<p>&lt;img onerror=x&gt; <strong>b</strong></p>', c.mdToHtml('<img onerror=x> **b**'));

console.log('\n' + (process.exitCode ? 'FAILED' : 'PASSED') + ' (' + pass + ' checks)');
