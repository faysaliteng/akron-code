'use strict';
// Akron Bot — Design + Slides canvas artifact types.
//
// Two branded frame types that Claude Desktop ships (a canvas of live
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

const { designRuntime, slidesRuntime } = require('./artifactcanvas-runtime');

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

// Artboard size: absent, 0 or negative all mean "fluid", so they must stay 0
// instead of being lifted to the minimum usable frame. Positive values clamp to
// a sane range so a stray 99999 cannot blow out the canvas.
const clampSize = (v, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return clampInt(n, 120, hi, 0);
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
    // A leading markdown H1 is the *document* name, not part of the first frame — without
    // this the frame type ("Design") leaked into the title and the window tab read "Design".
    const lines = raw.split(/\r?\n/);
    const firstIdx = lines.findIndex((l) => l.trim());
    const h1 = firstIdx >= 0 ? /^[ \t]*#[ \t]+(.+?)[ \t]*$/.exec(lines[firstIdx]) : null;
    let body = raw;
    if (!title && h1) {
      title = h1[1].trim().slice(0, 120);
      body = lines.slice(firstIdx + 1).join('\n');
    }
    boards = splitSections(body).map((chunk, i) => {
      const h = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(chunk);
      const named = h && !/[<>]/.test(chunk) ? h[1].trim().slice(0, 60) : '';
      return { name: named || `Artboard ${i + 1}`, html: chunk };
    });
  }
  const artboards = boards.map((b, i) => {
    const isObj = b && typeof b === 'object';
    const rawHtml = isObj ? (b.html != null ? b.html : b.content != null ? b.content : b.markdown) : b;
    let html = String(rawHtml == null ? '' : rawHtml);
    // Markdown design boards (what a model usually writes) render as a real page instead
    // of raw text inside the iframe. Same rule the deck parser uses: prose with some
    // letters and no markup is markdown; anything containing tags is HTML and left alone.
    if (html && /[A-Za-z]/.test(html) && !/[<>]/.test(html)) html = mdToHtml(html);
    return {
      name: String((isObj && (b.name || b.title)) || `Artboard ${i + 1}`),
      html,
      width: clampSize(isObj ? b.width : null, 2400),
      height: clampSize(isObj ? b.height : null, 4000),
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
    // The deck takes its name from the markdown H1 (usually the cover slide's heading),
    // so a real deck titles itself instead of always reading "Deck".
    const deckHead = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(raw);
    if (!title && deckHead) title = deckHead[1].trim().slice(0, 120);
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
:root{--bg:#1e1f1c;--panel:#26271f;--ink:#e8e6df;--muted:#a6a49a;--line:#3a3b33;--accent:#10b981}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:7px;
  padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.on{background:var(--accent);border-color:var(--accent);color:#fff}
`;

// ------------------------------------------------------- edit application ---
// The generated content is the base; hand edits are a patch on top. Both the
// document builder and the artifact window go through these so every surface
// shows the same deck.
const clampFloat = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

function normalizeBoard(b, i) {
  const isObj = b && typeof b === 'object';
  const html = isObj ? (b.html != null ? b.html : b.content != null ? b.content : '') : b;
  return {
    name: String((isObj && (b.name || b.title)) || `Artboard ${i + 1}`),
    html: String(html == null ? '' : html),
    width: clampInt(isObj ? b.width : null, 0, 2400, 0),
    height: clampInt(isObj ? b.height : null, 0, 4000, 0),
    notes: String((isObj && (b.notes || b.description)) || ''),
  };
}

function normalizeSlide(s, i) {
  const isObj = s && typeof s === 'object';
  return {
    title: String((isObj && (s.title || s.heading)) || `Slide ${i + 1}`),
    html: String((isObj && (s.html != null ? s.html : s.content != null ? s.content : '')) ?? ''),
    notes: String((isObj && (s.notes || s.speakerNotes)) || ''),
    layout: String((isObj && s.layout) || 'default'),
  };
}

function applyDesignEdits(base, edits) {
  const e = edits && typeof edits === 'object' ? edits : {};
  const boards = Array.isArray(e.boards) && e.boards.length
    ? e.boards.slice(0, 60).map(normalizeBoard)
    : (base && base.artboards) || [];
  const comments = (Array.isArray(e.comments) ? e.comments : [])
    .filter((c) => c && typeof c === 'object')
    .slice(0, 500)
    .map((c) => ({
      i: clampInt(c.i, 0, Math.max(0, boards.length - 1), 0),
      x: clampFloat(c.x, 0, 100, 50),
      y: clampFloat(c.y, 0, 100, 50),
      text: String(c.text == null ? '' : c.text).slice(0, 400),
    }))
    .filter((c) => c.text && c.i < boards.length);
  return {
    title: typeof e.title === 'string' && e.title.trim() ? e.title.trim().slice(0, 120) : (base && base.title) || 'Design',
    layout: ['grid', 'row', 'column'].includes(e.layout) ? e.layout : 'grid',
    zoom: clampFloat(e.zoom, 0.5, 2, 1),
    artboards: boards,
    comments,
  };
}

function applySlidesEdits(base, edits) {
  const e = edits && typeof edits === 'object' ? edits : {};
  const slides = Array.isArray(e.slides) && e.slides.length
    ? e.slides.slice(0, 200).map(normalizeSlide)
    : (base && base.slides) || [];
  return {
    title: typeof e.title === 'string' && e.title.trim() ? e.title.trim().slice(0, 120) : (base && base.title) || 'Deck',
    aspect: e.aspect === '4:3' ? '4:3' : '16:9',
    slides,
  };
}


function designHtml(name, content, edits, meta) {
  const view = applyDesignEdits(parseDesign(content), edits);
  const { title, artboards, layout, zoom, comments } = view;
  const pinsFor = (i) => comments.filter((c) => c.i === i)
    .map((c) => `<span class="pin" style="left:${c.x}%;top:${c.y}%" title="${esc(c.text)}"><b>${esc(c.text.slice(0, 40))}</b></span>`).join('');
  const deviceSel = (b) => {
    const opts = [['fluid', 'Fluid'], ['390x844', '390 × 844'], ['768x1024', '768 × 1024'], ['1440x900', '1440 × 900']];
    const cur = !b.width ? 'fluid' : `${b.width}x${b.height || 520}`;
    return `<select data-sel="device" title="Device width">` +
      opts.map(([v, lbl]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${lbl}</option>`).join('') + '</select>';
  };
  const cards = artboards.map((b, i) => {
    const w = b.width || 0;
    const h = b.height || 520;
    return `<figure class="board" data-i="${i}">
      <figcaption><span class="bname" contenteditable="true" spellcheck="false" data-edit="name" data-i="${i}">${esc(b.name)}</span>
        <span class="dims">${w ? w + '×' + h : 'fluid'}</span>
        <span class="bacts">
          ${deviceSel(b)}
          <button data-act="up" data-i="${i}" title="Move earlier">↑</button>
          <button data-act="down" data-i="${i}" title="Move later">↓</button>
          <button data-act="src" data-i="${i}">Edit HTML</button>
          <button data-act="dup" data-i="${i}">Duplicate</button>
          <button data-act="del" data-i="${i}">Delete</button>
          <button data-act="zoom" data-i="${i}">Zoom</button>
          <button data-act="save" data-i="${i}">Save .html</button>
        </span></figcaption>
      <div class="frame" style="${w ? `width:${w}px;height:${h}px` : 'width:100%;height:' + h + 'px'}">
        <iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="${esc(b.html)}"></iframe>
        <div class="pins" data-i="${i}">${pinsFor(i)}</div>
      </div>
      ${b.notes ? `<p class="note">${esc(b.notes)}</p>` : ''}
    </figure>`;
  }).join('\n');

  const rail = artboards.map((b, i) =>
    `<button class="railitem" data-act="jump" data-i="${i}">${esc(b.name)}</button>`).join('');
  const payload = JSON.stringify({
    title, layout, zoom, boards: artboards, comments,
    // Echoed back on every change so the surface that receives the message
    // (the in-chat preview posts to its parent) knows which slot to write.
    key: (meta && meta.key) || '',
  }).replace(/</g, '\\u003c');

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
.canvas.layout-row{flex-wrap:nowrap;overflow-x:auto;padding-bottom:10px}
.canvas.layout-column{flex-direction:column;flex-wrap:nowrap}
.canvas.layout-column .board{width:100%}
.bacts select{font-size:11px;padding:2px 4px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:6px}
.bname{outline:none;border-radius:4px;padding:1px 3px}
.bname:focus{background:#31322a;box-shadow:0 0 0 1px var(--accent)}
.frame{position:relative}
.pins{position:absolute;inset:0;pointer-events:none}
.canvas.commenting .pins{pointer-events:auto;cursor:crosshair;
  background:repeating-linear-gradient(45deg,rgba(16,185,129,.06) 0 8px,transparent 8px 16px)}
.pin{position:absolute;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;
  display:flex;align-items:center;gap:5px;max-width:180px}
.pin::before{content:'';width:12px;height:12px;border-radius:50%;background:var(--accent);
  border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);flex:0 0 auto}
.pin b{font-size:10px;font-weight:500;color:var(--ink);background:#16170f;border:1px solid var(--line);
  border-radius:5px;padding:2px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ttl{outline:none;border-radius:4px;padding:1px 4px}
#ttl:focus{background:#31322a;box-shadow:0 0 0 1px var(--accent)}
#status{min-height:16px;margin:10px 2px 0;color:var(--muted);font-size:12px}
.railfoot{margin-top:10px}
.railfoot button{width:100%;font-size:12px}
.drawer{position:fixed;right:0;top:0;bottom:0;width:min(560px,86vw);background:var(--panel);
  border-left:1px solid var(--line);display:none;grid-template-rows:auto 1fr;z-index:12}
.drawer.open{display:grid}
.drawerbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.drawer textarea{width:100%;height:100%;border:0;resize:none;padding:12px;background:#14150f;
  color:#dfe3d4;font:12px/1.5 ui-monospace,Menlo,monospace;outline:none}
</style></head><body>
<aside><h1>Artboards</h1><div id="rail">${rail || '<p class="note">No artboards.</p>'}</div>
  <div class="railfoot"><button data-act="add">+ Artboard</button></div></aside>
<main>
  <header><h2 id="ttl" contenteditable="true" spellcheck="false">${esc(title)}</h2>
    <span class="dims" id="cnt">${artboards.length} artboard${artboards.length === 1 ? '' : 's'}</span>
    <span class="sp"></span>
    <button data-act="layout" data-l="grid"${layout === 'grid' ? ' class="on"' : ''}>Grid</button>
    <button data-act="layout" data-l="row"${layout === 'row' ? ' class="on"' : ''}>Row</button>
    <button data-act="layout" data-l="column"${layout === 'column' ? ' class="on"' : ''}>Column</button>
    <button data-act="zoom-out">−</button><span id="zlbl">${Math.round(zoom * 100)}%</span><button data-act="zoom-in">+</button>
    <button data-act="comment-mode">Comment</button>
    <button data-act="print">Print / PDF</button>
    <button data-act="save-all">Save all</button>
  </header>
  <div class="canvas layout-${layout}" id="canvas" style="zoom:${zoom}">${cards || '<p class="note">Nothing to render.</p>'}</div>
  <p class="note" id="status"></p>
</main>
<div class="drawer" id="drawer"><div class="drawerbar">
  <strong id="dname">Artboard</strong><span class="sp" style="flex:1"></span>
  <button data-act="apply-src">Apply</button><button data-act="close-drawer">Close</button></div>
  <textarea id="dsrc" spellcheck="false"></textarea></div>
<div class="zoom" id="zoom"><div class="zoombar">
  <strong id="zname"></strong><span class="sp" style="flex:1"></span>
  <button data-act="close-zoom">Close</button></div>
  <div class="zoomstage" id="zstage"></div></div>
<script>(${designRuntime.toString()})(${payload});</script></body></html>`;
}

function slidesHtml(name, content, edits, meta) {
  const view = applySlidesEdits(parseSlides(content), edits);
  const { title, slides, aspect } = view;
  const deck = slides.map((s, i) => `<section class="slide${i === 0 ? ' active' : ''}" data-i="${i}">
      <h1 class="stitle">${esc(s.title)}</h1>
      <div class="sbody">${s.html}</div>
      ${s.notes ? `<aside class="snotes">${esc(s.notes)}</aside>` : ''}
    </section>`).join('\n');
  const thumbs = slides.map((s, i) =>
    `<button class="thumb${i === 0 ? ' on' : ''}" data-act="goto" data-i="${i}"><span class="tnum">${i + 1}</span><span class="ttl">${esc(s.title)}</span></button>`).join('');
  const payload = JSON.stringify({
    title, aspect, slides: slides.map((s) => ({ title: s.title, html: s.html, notes: s.notes, layout: s.layout })),
    key: (meta && meta.key) || '',
  }).replace(/</g, '\\u003c');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(name || title)} — Slides</title><style>${BASE_CSS}
body{display:grid;grid-template-columns:196px 1fr;height:100vh;overflow:hidden}
#thumbs{border-right:1px solid var(--line);background:var(--panel);overflow:auto;padding:10px}
#thumbs h1{margin:2px 6px 10px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.thumb{display:flex;gap:8px;align-items:center;width:100%;text-align:left;border:1px solid var(--line);
  border-radius:8px;padding:8px;margin-bottom:8px;background:var(--bg)}
.thumb:hover{border-color:var(--accent)}
.thumb.on{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.tnum{font-variant-numeric:tabular-nums;color:var(--muted);font-size:11px;min-width:16px}
.ttl{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
main{display:grid;grid-template-rows:auto 1fr auto;min-width:0;overflow:hidden}
header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
header h2{font-size:15px;margin:0;font-weight:600}
#ttl{outline:none;border-radius:4px;padding:1px 4px}
#ttl:focus{background:#31322a;box-shadow:0 0 0 1px var(--accent)}
header .sp{flex:1}
header button{padding:4px 9px;font-size:12px}
#stage{position:relative;display:grid;place-items:center;padding:24px 30px;overflow:hidden;min-height:0}
.slide{display:none;width:min(1024px,100%);background:#fbf9f4;color:#20211c;
  border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:44px 52px;overflow:auto;max-height:100%}
#stage.aspect-169 .slide{aspect-ratio:16/9}
#stage.aspect-43 .slide{aspect-ratio:4/3}
.slide.active{display:block}
.stitle{margin:0 0 18px;font-size:30px;line-height:1.15;letter-spacing:-.01em;color:#1b1c18;outline:none}
.slide .stitle:empty{display:none}
.sbody{font-size:18px;line-height:1.55;outline:none}
.sbody h1,.sbody h2{font-size:24px;margin:0 0 10px}
.sbody ul,.sbody ol{margin:0;padding-left:22px}
.sbody li{margin:6px 0}
.sbody code{background:#ece8dd;border-radius:4px;padding:1px 5px;font-size:.92em}
.snotes{margin-top:22px;border-top:1px dashed #cfc9ba;padding-top:12px;color:#6b6a62;font-size:13px;outline:none}
.nopnotes .snotes{display:none}
[contenteditable="true"]:focus{box-shadow:0 0 0 2px rgba(16,185,129,.5);border-radius:5px}
[contenteditable="true"]:empty:before{content:'Type here…';color:#b3ae9f}
#bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--line);background:var(--panel)}
#prog{flex:1;height:4px;background:#33342c;border-radius:3px;overflow:hidden}
#prog i{display:block;height:100%;width:0;background:var(--accent);transition:width .18s ease}
#count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;min-width:62px;text-align:right}
#status{color:var(--muted);font-size:12px;margin-left:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}
@media print{
  body{display:block;height:auto;background:#fff}
  main{display:block}
  #thumbs,header,#bar{display:none}
  #stage{display:block;padding:0}
  .slide{display:block !important;page-break-after:always;box-shadow:none;border-radius:0;
    width:100%;aspect-ratio:auto;min-height:96vh;max-height:none;background:#fff}
}
</style></head><body>
<aside id="thumbs"><h1>Slides</h1>${thumbs || '<p class="note">Empty</p>'}</aside>
<main>
  <header>
    <h2 id="ttl" contenteditable="true" spellcheck="false">${esc(title)}</h2>
    <span class="sp"></span>
    <button data-act="edit">Edit</button>
    <button data-act="aspect">${aspect}</button>
    <button data-act="add">+ Slide</button>
    <button data-act="dup">Duplicate</button>
    <button data-act="del">Delete</button>
    <button data-act="up" title="Move earlier">↑</button>
    <button data-act="down" title="Move later">↓</button>
    <button data-act="drive">Save to Drive</button>
    <button data-act="pptx">Export .pptx</button>
    <button data-act="html">Export HTML</button>
    <button data-act="md">Export MD</button>
  </header>
  <div id="stage" class="aspect-${aspect === '4:3' ? '43' : '169'}">${deck || '<p class="note">No slides.</p>'}</div>
  <div id="bar">
    <button data-nav="prev">‹ Prev</button>
    <button data-nav="next">Next ›</button>
    <span id="prog"><i></i></span>
    <span id="count">1 / ${slides.length || 1}</span>
    <button data-act="notes" class="on">Notes</button>
    <button data-act="full">Present</button>
    <button data-act="print">Print / PDF</button>
    <span id="status"></span>
  </div>
</main>
<script>(${slidesRuntime.toString()})(${payload});</script></body></html>`;
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

function canvasHtml(language, name, content, edits, meta) {
  const lang = String(language || '').toLowerCase().trim();
  const build = CANVAS[lang];
  if (!build) return null;
  return build(name, content, edits, meta);
}

module.exports = {
  parseDesign,
  parseSlides,
  designHtml,
  slidesHtml,
  canvasHtml,
  isCanvas,
  mdToHtml,
  applyDesignEdits,
  applySlidesEdits,
};
