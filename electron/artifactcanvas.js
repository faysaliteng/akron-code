'use strict';
// Helio Bot — Design + Slides canvas artifact types.
//
// Two branded frame types that Example Desktop ships (a canvas of live
// artboards and a navigable deck). Both are pure HTML documents built here so
// the artifact window, the in-chat preview and print-to-PDF all render the same
// surface. No third-party code, no network.
//
// Content contract (what the Artifact tool receives as `content`):
//
//   language: 'design'
//     { "title": "...", "artboards": [
//        { "name": "Landing", "html": "<div>…</div>", "width": 390, "height": 844, "notes": "…" },
//        … ] }
//     also accepted: a bare array, or artboard HTML sections separated by `---`.
//
//   language: 'slides'
//     { "title": "...", "slides": [
//        { "title": "Q3 review", "html": "<h1>…</h1>", "bullets": ["…"], "notes": "…" },
//        … ] }
//     also accepted: a bare array, or a markdown deck split on `---`
//     (each chunk: first `# heading` becomes the slide title, rest renders).

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

// ---------------------------------------------------------------- parsing ---
function tryJson(raw) {
  const s = String(raw || '').trim();
  const candidates = [s];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) candidates.push(fence[1].trim());
  const first = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const start = firstArr !== -1 && (first === -1 || firstArr < first) ? firstArr : first;
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (start !== -1 && end > start) candidates.push(s.slice(start, end + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch (_) { /* next */ }
  }
  return undefined;
}

function splitSections(raw) {
  return String(raw || '')
    .split(/\n\s*---+\s*\n/)
    .map((s) => s.replace(/^\s+|\s+$/g, ''))
    .filter(Boolean);
}

function parseDesign(content) {
  const raw = String(content == null ? '' : content);
  let obj = tryJson(raw);
  let boards = [];
  let title = '';
  if (Array.isArray(obj)) boards = obj;
  else if (obj && typeof obj === 'object') {
    title = String(obj.title || obj.name || '');
    boards = Array.isArray(obj.artboards) ? obj.artboards : Array.isArray(obj.frames) ? obj.frames : [];
  }
  if (!boards.length) {
    // Plain HTML / markdown: one artboard per `---` section (a single frame when unsplit).
    boards = splitSections(raw).map((chunk, i) => ({ name: `Artboard ${i + 1}`, html: chunk }));
  }
  const artboards = boards.map((b, i) => {
    const isObj = b && typeof b === 'object';
    const html = isObj ? (b.html != null ? b.html : b.content != null ? b.content : b.markdown) : b;
    return {
      name: String((isObj && (b.name || b.title)) || `Artboard ${i + 1}`),
      html: String(html == null ? '' : html),
      width: clampInt(isObj ? b.width : null, 120, 2400, 0),
      height: clampInt(isObj ? b.height : null, 120, 4000, 0),
      notes: String((isObj && (b.notes || b.description)) || ''),
    };
  });
  return { title: title || 'Design', artboards };
}

function mdToHtml(md) {
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { closeList(); continue; }
    const m = /^(#{1,6})\s+(.*)$/.exec(t);
    if (m) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p>${inline(t)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function parseSlides(content) {
  const raw = String(content == null ? '' : content);
  const obj = tryJson(raw);
  let list = [];
  let title = '';
  if (Array.isArray(obj)) list = obj;
  else if (obj && typeof obj === 'object') {
    title = String(obj.title || obj.name || '');
    list = Array.isArray(obj.slides) ? obj.slides : Array.isArray(obj.deck) ? obj.deck : [];
  }
  if (!list.length) {
    list = splitSections(raw).map((chunk) => {
      const head = /^\s*#{1,3}\s+(.+)$/m.exec(chunk);
      const body = head ? chunk.replace(head[0], '').trim() : chunk;
      return { title: head ? head[1].trim() : '', html: mdToHtml(body) };
    });
  }
  const slides = list.map((s, i) => {
    const isObj = s && typeof s === 'object';
    const bullets = isObj && Array.isArray(s.bullets) ? s.bullets.map((b) => String(b)) : [];
    let html = isObj ? (s.html != null ? s.html : s.content != null ? s.content : null) : null;
    if (html == null) {
      html = bullets.length
        ? `<ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`
        : mdToHtml(isObj ? '' : String(s || ''));
    } else if (typeof html === 'string' && isObj && /^[\s\S]*[A-Za-z]/.test(html) && !/[<>]/.test(html)) {
      html = mdToHtml(html); // markdown body, not markup
    } else {
      html = String(html);
    }
    return {
      title: String((isObj && (s.title || s.heading)) || `Slide ${i + 1}`),
      html,
      notes: String((isObj && (s.notes || s.speakerNotes)) || ''),
      layout: String((isObj && s.layout) || 'default'),
    };
  });
  return { title: title || 'Deck', slides };
}

// ------------------------------------------------------------- documents ---
const BASE_CSS = `
:root{--bg:#1e1f1c;--panel:#26271f;--ink:#e8e6df;--muted:#a6a49a;--line:#3a3b33;--accent:#D97757}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:7px;
  padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
`;

function designHtml(name, content) {
  const { title, artboards } = parseDesign(content);
  const cards = artboards.map((b, i) => {
    const w = b.width || 0;
    const h = b.height || 520;
    return `<figure class="board" data-i="${i}">
      <figcaption><span class="bname">${esc(b.name)}</span>
        <span class="dims">${w ? w + '×' + h : 'fluid'}</span>
        <span class="bacts">
          <button data-act="zoom" data-i="${i}">Zoom</button>
          <button data-act="save" data-i="${i}">Save .html</button>
        </span></figcaption>
      <div class="frame" style="${w ? `width:${w}px;height:${h}px` : 'width:100%;height:' + h + 'px'}">
        <iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="${esc(b.html)}"></iframe>
      </div>
      ${b.notes ? `<p class="note">${esc(b.notes)}</p>` : ''}
    </figure>`;
  }).join('\n');

  const rail = artboards.map((b, i) =>
    `<button class="railitem" data-act="jump" data-i="${i}">${esc(b.name)}</button>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name || title)} — Design</title><style>${BASE_CSS}
body{display:grid;grid-template-columns:190px 1fr;height:100%}
aside{border-right:1px solid var(--line);background:var(--panel);padding:12px 10px;overflow:auto}
aside h1{margin:2px 6px 12px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.railitem{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:6px 8px;color:var(--ink)}
.railitem:hover{background:#31322a;color:var(--accent)}
main{overflow:auto;padding:18px 22px 60px}
header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
header h2{font-size:16px;margin:0;font-weight:600}
header .sp{flex:1}
.canvas{display:flex;flex-wrap:wrap;gap:22px;align-items:flex-start}
.board{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px;max-width:100%}
figcaption{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
.bname{font-weight:600}
.dims{color:var(--muted)}
.bacts{margin-left:auto;display:flex;gap:6px}
.bacts button{padding:3px 8px;font-size:11px}
.frame{background:#fff;border-radius:8px;overflow:hidden;max-width:100%}
.frame iframe{border:0;width:100%;height:100%;display:block;background:#fff}
.note{margin:8px 2px 0;color:var(--muted);font-size:12px;max-width:56ch}
.zoom{position:fixed;inset:0;background:#12130f;display:none;grid-template-rows:auto 1fr;z-index:9}
.zoom.open{display:grid}
.zoombar{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)}
.zoomstage{overflow:auto;padding:16px;display:flex;justify-content:center}
.zoomstage .frame{background:#fff;max-width:none}
</style></head><body>
<aside><h1>Artboards</h1>${rail || '<p class="note">No artboards.</p>'}</aside>
<main>
  <header><h2>${esc(title)}</h2><span class="dims">${artboards.length} artboard${artboards.length === 1 ? '' : 's'}</span>
    <span class="sp"></span>
    <button data-act="print">Print / PDF</button>
    <button data-act="save-all">Save all</button>
  </header>
  <div class="canvas">${cards || '<p class="note">Nothing to render.</p>'}</div>
</main>
<div class="zoom" id="zoom"><div class="zoombar">
  <strong id="zname"></strong><span class="sp" style="flex:1"></span>
  <button data-act="close-zoom">Close</button></div>
  <div class="zoomstage" id="zstage"></div></div>
<script>
const BOARDS = ${JSON.stringify(artboards.map((b) => ({ name: b.name, html: b.html, width: b.width, height: b.height }))).replace(/</g, '\\u003c')};
const zoom = document.getElementById('zoom');
const zstage = document.getElementById('zstage');
const zname = document.getElementById('zname');
function save(i) {
  const b = BOARDS[i]; if (!b) return;
  const blob = new Blob([b.html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (b.name || 'artboard').replace(/[^\\w.-]+/g, '_') + '.html';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.getAttribute('data-act');
  const i = Number(t.getAttribute('data-i') || 0);
  if (act === 'print') window.print();
  else if (act === 'save') save(i);
  else if (act === 'save-all') BOARDS.forEach((_, k) => setTimeout(() => save(k), k * 120));
  else if (act === 'jump') { const el = document.querySelector('.board[data-i="' + i + '"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  else if (act === 'zoom') {
    const b = BOARDS[i]; if (!b) return;
    zname.textContent = b.name || 'Artboard';
    const w = b.width || 900, h = b.height || 640;
    zstage.innerHTML = '<div class="frame" style="width:' + w + 'px;height:' + h + 'px"></div>';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    f.srcdoc = b.html;
    zstage.firstElementChild.appendChild(f);
    zoom.classList.add('open');
  } else if (act === 'close-zoom') { zoom.classList.remove('open'); zstage.innerHTML = ''; }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { zoom.classList.remove('open'); zstage.innerHTML = ''; } });
</script></body></html>`;
}

function slidesHtml(name, content) {
  const { title, slides } = parseSlides(content);
  const deck = slides.map((s) => `<section class="slide">
      <h1 class="stitle">${esc(s.title)}</h1>
      <div class="sbody">${s.html}</div>
      ${s.notes ? `<aside class="snotes">${esc(s.notes)}</aside>` : ''}
    </section>`).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name || title)} — Slides</title><style>${BASE_CSS}
body{display:grid;grid-template-rows:1fr auto;height:100%;overflow:hidden}
#stage{position:relative;display:grid;place-items:center;padding:28px 34px;overflow:hidden}
.slide{display:none;width:min(1024px,100%);aspect-ratio:16/9;background:#fbf9f4;color:#20211c;
  border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:44px 52px;overflow:auto}
.slide.active{display:block}
.stitle{margin:0 0 18px;font-size:30px;line-height:1.15;letter-spacing:-.01em;color:#1b1c18}
.slide .stitle:empty{display:none}
.sbody{font-size:18px;line-height:1.55}
.sbody h1,.sbody h2{font-size:24px;margin:0 0 10px}
.sbody ul,.sbody ol{margin:0;padding-left:22px}
.sbody li{margin:6px 0}
.sbody code{background:#ece8dd;border-radius:4px;padding:1px 5px;font-size:.92em}
.snotes{margin-top:22px;border-top:1px dashed #cfc9ba;padding-top:12px;color:#6b6a62;font-size:13px}
.nopnotes .snotes{display:none}
#bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--line);background:var(--panel)}
#prog{flex:1;height:4px;background:#33342c;border-radius:3px;overflow:hidden}
#prog i{display:block;height:100%;width:0;background:var(--accent);transition:width .18s ease}
#count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;min-width:62px;text-align:right}
@media print{
  body{display:block;height:auto;background:#fff}
  #stage{display:block;padding:0}
  #bar{display:none}
  .slide{display:block !important;page-break-after:always;box-shadow:none;border-radius:0;
    width:100%;aspect-ratio:auto;min-height:96vh;background:#fff}
}
</style></head><body>
<div id="stage">${deck || '<p class="note">No slides.</p>'}</div>
<div id="bar">
  <button data-nav="prev">‹ Prev</button>
  <button data-nav="next">Next ›</button>
  <span id="prog"><i></i></span>
  <span id="count">1 / ${slides.length || 1}</span>
  <button data-act="notes" class="on">Notes</button>
  <button data-act="full">Present</button>
  <button data-act="print">Print / PDF</button>
</div>
<script>
const slides = Array.from(document.querySelectorAll('.slide'));
let i = 0;
const prog = document.querySelector('#prog i');
const count = document.getElementById('count');
function show(n) {
  if (!slides.length) return;
  i = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((s, k) => s.classList.toggle('active', k === i));
  prog.style.width = ((i + 1) / slides.length * 100) + '%';
  count.textContent = (i + 1) + ' / ' + slides.length;
}
document.addEventListener('click', (e) => {
  const n = e.target.closest('[data-nav]'); if (n) {
    show(i + (n.getAttribute('data-nav') === 'next' ? 1 : -1)); return;
  }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.getAttribute('data-act');
  if (act === 'notes') { document.body.classList.toggle('nopnotes'); a.classList.toggle('on'); }
  else if (act === 'print') window.print();
  else if (act === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(i + 1); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1); }
  else if (e.key === 'Home') show(0);
  else if (e.key === 'End') show(slides.length - 1);
  else if (e.key.toLowerCase() === 'n') document.body.classList.toggle('nopnotes');
  else if (e.key.toLowerCase() === 'f') document.documentElement.requestFullscreen();
});
show(0);
</script></body></html>`;
}

// The language values that route to a canvas document, and the builder for each.
const CANVAS = {
  design: designHtml,
  canvas: designHtml,
  artboard: designHtml,
  slides: slidesHtml,
  deck: slidesHtml,
  presentation: slidesHtml,
};

function isCanvas(language) {
  return Object.prototype.hasOwnProperty.call(CANVAS, String(language || '').toLowerCase().trim());
}

function canvasHtml(language, name, content) {
  const lang = String(language || '').toLowerCase().trim();
  const build = CANVAS[lang];
  if (!build) return null;
  return build(name, content);
}

module.exports = { parseDesign, parseSlides, designHtml, slidesHtml, canvasHtml, isCanvas, mdToHtml };
