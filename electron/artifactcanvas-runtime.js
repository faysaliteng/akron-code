'use strict';
// Helio Bot — interactive runtime embedded in Design / Slides canvas artifacts.
//
// These two functions are serialized with `.toString()` and inlined into the
// generated document, so they must be completely self-contained: no imports, no
// references to module scope, no template literals, no "</script>" sequences.
// Each receives a payload (see `canvasPayload` in artifactcanvas.js) and takes
// over the static markup the server already rendered.
//
// Editing model: the runtime owns the whole state and republishes it on every
// change. Persistence goes through `window.helioArtifact` (artifact window, via
// artifact-preload.js), or `parent.postMessage` (in-chat preview), or
// localStorage where an origin exists. All optional — a document opened with no
// bridge still edits in memory.

function designRuntime(p) {
  var KEY = p.key || '';
  var TITLE = p.title || 'Design';
  var LAYOUT = p.layout || 'grid';
  var ZOOM = Number(p.zoom) || 1;
  var BOARDS = (p.boards || []).map(function (b, i) {
    return {
      name: b.name || 'Artboard ' + (i + 1),
      html: b.html == null ? '' : String(b.html),
      width: Number(b.width) || 0,
      height: Number(b.height) || 0,
      notes: b.notes || '',
    };
  });
  var PINS = (p.comments || []).filter(function (c) { return c && typeof c === 'object'; })
    .map(function (c) {
      return { i: Number(c.i) || 0, x: Number(c.x) || 0, y: Number(c.y) || 0, text: String(c.text || '') };
    });

  var BRIDGE = (typeof window !== 'undefined' && window.helioArtifact) ? window.helioArtifact : null;
  var commenting = false;
  var editing = -1;
  var canvas = document.getElementById('canvas');
  var rail = document.getElementById('rail');
  var cnt = document.getElementById('cnt');
  var zlbl = document.getElementById('zlbl');
  var status = document.getElementById('status');
  var drawer = document.getElementById('drawer');
  var dsrc = document.getElementById('dsrc');
  var dname = document.getElementById('dname');
  var zoomEl = document.getElementById('zoom');
  var zstage = document.getElementById('zstage');
  var zname = document.getElementById('zname');
  var ttl = document.getElementById('ttl');

  function e(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg) {
    if (!status) return;
    status.textContent = msg || '';
    if (msg) setTimeout(function () { if (status.textContent === msg) status.textContent = ''; }, 2600);
  }
  function state() {
    return { title: TITLE, layout: LAYOUT, zoom: ZOOM, boards: BOARDS, comments: PINS };
  }
  function push() {
    var s = state();
    if (BRIDGE && BRIDGE.save) { BRIDGE.save(s).catch(function () {}); return; }
    try { localStorage.setItem('helio:canvas', JSON.stringify(s)); } catch (_) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'helio:artifact-change', key: KEY, patch: s }, '*');
      }
    } catch (_) {}
  }
  function frameStyle(b) {
    var h = b.height || 520;
    return b.width ? 'width:' + b.width + 'px;height:' + h + 'px' : 'width:100%;height:' + h + 'px';
  }

  function pinsHTML(i) {
    var rows = PINS.filter(function (c) { return c.i === i; });
    if (!rows.length) return '';
    return rows.map(function (c) {
      return '<span class="pin" style="left:' + c.x + '%;top:' + c.y + '%" title="' + e(c.text) + '">' +
        '<b>' + e(c.text.slice(0, 40)) + '</b></span>';
    }).join('');
  }
  function boardHTML(b, i) {
    return '<figure class="board" data-i="' + i + '">' +
      '<figcaption><span class="bname" contenteditable="true" spellcheck="false" data-edit="name" data-i="' + i + '">' + e(b.name) + '</span>' +
      '<span class="dims">' + (b.width ? b.width + '×' + (b.height || 520) : 'fluid') + '</span>' +
      '<span class="bacts">' +
      '<select data-sel="device" data-i="' + i + '" title="Device width">' +
      ['fluid', '390x844', '768x1024', '1440x900'].map(function (v) {
        var on = (v === 'fluid' && !b.width) || (v === '390x844' && b.width === 390) ||
          (v === '768x1024' && b.width === 768) || (v === '1440x900' && b.width === 1440);
        return '<option value="' + v + '"' + (on ? ' selected' : '') + '>' + (v === 'fluid' ? 'Fluid' : v.replace('x', ' × ')) + '</option>';
      }).join('') + '</select>' +
      '<button data-act="up" data-i="' + i + '" title="Move up">↑</button>' +
      '<button data-act="down" data-i="' + i + '" title="Move down">↓</button>' +
      '<button data-act="src" data-i="' + i + '">Edit HTML</button>' +
      '<button data-act="dup" data-i="' + i + '">Duplicate</button>' +
      '<button data-act="del" data-i="' + i + '">Delete</button>' +
      '<button data-act="zoom" data-i="' + i + '">Zoom</button>' +
      '<button data-act="save" data-i="' + i + '">Save .html</button>' +
      '</span></figcaption>' +
      '<div class="frame" style="' + frameStyle(b) + '">' +
      '<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="' + e(b.html) + '"></iframe>' +
      '<div class="pins" data-i="' + i + '">' + pinsHTML(i) + '</div>' +
      '</div>' +
      (b.notes ? '<p class="note">' + e(b.notes) + '</p>' : '') +
      '</figure>';
  }
  function render() {
    if (canvas) canvas.innerHTML = BOARDS.length
      ? BOARDS.map(boardHTML).join('')
      : '<p class="note">No artboards yet — use + Artboard.</p>';
    if (rail) {
      rail.innerHTML = BOARDS.map(function (b, i) {
        return '<button class="railitem" data-act="jump" data-i="' + i + '">' + e(b.name) + '</button>';
      }).join('') || '<p class="note">No artboards.</p>';
    }
    if (cnt) cnt.textContent = BOARDS.length + ' artboard' + (BOARDS.length === 1 ? '' : 's');
    if (ttl) ttl.textContent = TITLE;
    applyLayout();
  }
  function applyLayout() {
    if (!canvas) return;
    canvas.className = 'canvas layout-' + LAYOUT;
    canvas.style.zoom = String(ZOOM);
    if (zlbl) zlbl.textContent = Math.round(ZOOM * 100) + '%';
  }

  function move(i, d) {
    var j = i + d;
    if (i < 0 || i >= BOARDS.length || j < 0 || j >= BOARDS.length) return;
    var t = BOARDS[i]; BOARDS[i] = BOARDS[j]; BOARDS[j] = t;
    PINS.forEach(function (c) {
      if (c.i === i) c.i = j; else if (c.i === j) c.i = i;
    });
    render(); push();
  }
  function saveOne(i) {
    var b = BOARDS[i]; if (!b) return;
    var blob = new Blob([b.html], { type: 'text/html' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String(b.name || 'artboard').replace(/[^\w.-]+/g, '_') + '.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function openZoom(i) {
    var b = BOARDS[i]; if (!b || !zoomEl) return;
    if (zname) zname.textContent = b.name || 'Artboard';
    var w = b.width || 900, h = b.height || 640;
    zstage.innerHTML = '<div class="frame" style="width:' + w + 'px;height:' + h + 'px"></div>';
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    f.srcdoc = b.html;
    zstage.firstElementChild.appendChild(f);
    zoomEl.classList.add('open');
  }
  function closeZoom() {
    if (!zoomEl) return;
    zoomEl.classList.remove('open');
    if (zstage) zstage.innerHTML = '';
  }
  function openDrawer(i) {
    var b = BOARDS[i]; if (!b || !drawer) return;
    editing = i;
    if (dname) dname.textContent = b.name;
    dsrc.value = b.html;
    drawer.classList.add('open');
  }
  function closeDrawer() { editing = -1; if (drawer) drawer.classList.remove('open'); }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    var i = Number(t.getAttribute('data-i') || 0);
    if (act === 'print') { if (BRIDGE && BRIDGE.print) BRIDGE.print().catch(function () {}); else window.print(); }
    else if (act === 'save') saveOne(i);
    else if (act === 'save-all') BOARDS.forEach(function (_, k) { setTimeout(function () { saveOne(k); }, k * 120); });
    else if (act === 'jump') {
      var el = document.querySelector('.board[data-i="' + i + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    else if (act === 'zoom') openZoom(i);
    else if (act === 'close-zoom') closeZoom();
    else if (act === 'up') move(i, -1);
    else if (act === 'down') move(i, 1);
    else if (act === 'dup') {
      var src = BOARDS[i];
      if (!src) return;
      BOARDS.splice(i + 1, 0, { name: src.name + ' copy', html: src.html, width: src.width, height: src.height, notes: src.notes });
      render(); push(); say('Duplicated.');
    }
    else if (act === 'del') {
      if (BOARDS.length <= 1) { say('Keep at least one artboard.'); return; }
      BOARDS.splice(i, 1);
      PINS = PINS.filter(function (c) { return c.i !== i; }).map(function (c) { return c.i > i ? { i: c.i - 1, x: c.x, y: c.y, text: c.text } : c; });
      render(); push(); say('Deleted.');
    }
    else if (act === 'add') {
      BOARDS.push({ name: 'Artboard ' + (BOARDS.length + 1), html: '<div style="font:14px system-ui;padding:16px;color:#222">New artboard</div>', width: 390, height: 844, notes: '' });
      render(); push(); say('Artboard added.');
    }
    else if (act === 'src') openDrawer(i);
    else if (act === 'apply-src') {
      if (editing < 0 || !BOARDS[editing]) { closeDrawer(); return; }
      BOARDS[editing].html = dsrc.value;
      render(); push(); closeDrawer(); say('Artboard HTML updated.');
    }
    else if (act === 'close-drawer') closeDrawer();
    else if (act === 'layout') { LAYOUT = t.getAttribute('data-l'); syncLayout(); applyLayout(); push(); }
    else if (act === 'zoom-in') { ZOOM = Math.min(2, Math.round((ZOOM + 0.1) * 10) / 10); applyLayout(); push(); }
    else if (act === 'zoom-out') { ZOOM = Math.max(0.5, Math.round((ZOOM - 0.1) * 10) / 10); applyLayout(); push(); }
    else if (act === 'comment-mode') {
      commenting = !commenting;
      t.classList.toggle('on', commenting);
      if (canvas) canvas.classList.toggle('commenting', commenting);
      say(commenting ? 'Comment mode: click an artboard to drop a pin.' : '');
    }
    else if (act === 'pin-del') { ev.stopPropagation(); }
  });

  function syncLayout() {
    var btns = document.querySelectorAll('[data-act="layout"]');
    for (var k = 0; k < btns.length; k++) {
      btns[k].classList.toggle('on', btns[k].getAttribute('data-l') === LAYOUT);
    }
  }

  document.addEventListener('change', function (ev) {
    var s = ev.target.closest ? ev.target.closest('[data-sel="device"]') : null;
    if (!s) return;
    var i = Number(s.getAttribute('data-i') || 0);
    var b = BOARDS[i]; if (!b) return;
    var v = s.value;
    if (v === 'fluid') { b.width = 0; b.height = 0; }
    else { b.width = Number(v.split('x')[0]) || 0; b.height = Number(v.split('x')[1]) || 0; }
    render(); push(); say('Size set to ' + (v === 'fluid' ? 'fluid' : v.replace('x', ' × ')) + '.');
  });

  document.addEventListener('focusout', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-edit') === 'name') {
      var i = Number(t.getAttribute('data-i') || 0);
      var v = String(t.textContent || '').trim().slice(0, 120);
      if (BOARDS[i] && v) { BOARDS[i].name = v; render(); push(); }
      else if (BOARDS[i]) { t.textContent = BOARDS[i].name; }
    } else if (t.id === 'ttl') {
      var tv = String(t.textContent || '').trim().slice(0, 120);
      if (tv) { TITLE = tv; push(); } else t.textContent = TITLE;
    }
  });

  if (canvas) {
    canvas.addEventListener('click', function (ev) {
      var pins = ev.target.closest ? ev.target.closest('.pins') : null;
      if (!pins || !commenting) return;
      var i = Number(pins.getAttribute('data-i') || 0);
      var r = pins.getBoundingClientRect();
      var x = Math.max(1, Math.min(99, Math.round(((ev.clientX - r.left) / Math.max(1, r.width)) * 100)));
      var y = Math.max(1, Math.min(99, Math.round(((ev.clientY - r.top) / Math.max(1, r.height)) * 100)));
      var text = window.prompt('Comment on "' + (BOARDS[i] ? BOARDS[i].name : 'artboard') + '":', '');
      if (text == null) return;
      text = String(text).trim();
      if (!text) return;
      PINS.push({ i: i, x: x, y: y, text: text.slice(0, 400) });
      render(); push(); say('Pin added.');
    });
    canvas.addEventListener('click', function (ev) {
      var pin = ev.target.closest ? ev.target.closest('.pin') : null;
      if (!pin) return;
      var box = pin.closest('.pins');
      if (!box) return;
      var i = Number(box.getAttribute('data-i') || 0);
      var px = parseFloat(String(pin.style.left)) || 0;
      var py = parseFloat(String(pin.style.top)) || 0;
      var idx = PINS.findIndex(function (c) { return c.i === i && Math.abs(c.x - px) < 0.6 && Math.abs(c.y - py) < 0.6; });
      if (idx < 0) return;
      var next = window.prompt('Edit comment (empty removes it):', PINS[idx].text);
      if (next == null) return;
      next = String(next).trim();
      if (!next) PINS.splice(idx, 1); else PINS[idx].text = next.slice(0, 400);
      render(); push();
    });
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { closeZoom(); closeDrawer(); }
  });

  render();
  syncLayout();
  applyLayout();
  say('');
}
function slidesRuntime(p) {
  var TITLE = p.title || 'Deck';
  var ASPECT = p.aspect === '4:3' ? '4:3' : '16:9';
  var SLIDES = (p.slides || []).map(function (s, i) {
    return {
      title: s.title || 'Slide ' + (i + 1),
      html: s.html == null ? '' : String(s.html),
      notes: s.notes || '',
      layout: s.layout || 'default',
    };
  });
  var BRIDGE = (typeof window !== 'undefined' && window.helioArtifact) ? window.helioArtifact : null;
  var i = 0;
  // Slides open straight into edit mode: the whole point of the canvas is to
  // click a title and type. "Edit" therefore starts as "Done" and turns
  // read-only preview back on.
  var editing = true;
  var stage = document.getElementById('stage');
  var thumbs = document.getElementById('thumbs');
  var bar = document.getElementById('bar');
  var prog = document.querySelector('#prog i');
  var count = document.getElementById('count');
  var status = document.getElementById('status');
  var ttl = document.getElementById('ttl');

  function e(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function say(msg) {
    if (!status) return;
    status.textContent = msg || '';
    if (msg) setTimeout(function () { if (status.textContent === msg) status.textContent = ''; }, 3200);
  }
  function state() {
    return { title: TITLE, aspect: ASPECT, slides: SLIDES };
  }
  function push() {
    var s = state();
    if (BRIDGE && BRIDGE.save) { BRIDGE.save(s).catch(function () {}); return; }
    try { localStorage.setItem('helio:slides', JSON.stringify(s)); } catch (_) {}
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'helio:artifact-change', key: KEY, patch: s }, '*');
      }
    } catch (_) {}
  }
  function collect() {
    if (ttl) {
      var tv = String(ttl.textContent || '').trim().slice(0, 120);
      if (tv) TITLE = tv;
    }
    var nodes = document.querySelectorAll('#stage .slide');
    for (var k = 0; k < nodes.length; k++) {
      var s = SLIDES[k]; if (!s) continue;
      var t = nodes[k].querySelector('.stitle'); if (t) s.title = String(t.textContent || '').trim() || s.title;
      var b = nodes[k].querySelector('.sbody'); if (b) s.html = b.innerHTML;
      var n = nodes[k].querySelector('.snotes'); if (n) s.notes = String(n.textContent || '').trim();
    }
  }
  function ed(val) { return editing ? ' contenteditable="true" spellcheck="false"' : ''; }
  function slideHTML(s, k) {
    return '<section class="slide' + (k === i ? ' active' : '') + '" data-i="' + k + '">' +
      '<h1 class="stitle"' + ed() + '>' + e(s.title) + '</h1>' +
      '<div class="sbody"' + ed() + '>' + (s.html || '') + '</div>' +
      (s.notes ? '<aside class="snotes"' + ed() + '>' + e(s.notes) + '</aside>' : '') +
      '</section>';
  }
  var editBtn = document.querySelector('header [data-act="edit"]');
  function syncEdit() {
    if (!editBtn) return;
    editBtn.classList.toggle('on', editing);
    editBtn.textContent = editing ? 'Done' : 'Edit';
  }
  function thumbHTML(s, k) {
    return '<button class="thumb' + (k === i ? ' on' : '') + '" data-act="goto" data-i="' + k + '">' +
      '<span class="tnum">' + (k + 1) + '</span><span class="ttl">' + e(s.title) + '</span></button>';
  }
  function render() {
    if (ttl) ttl.textContent = TITLE;
    if (stage) {
      stage.className = 'aspect-' + (ASPECT === '4:3' ? '43' : '169');
      stage.innerHTML = SLIDES.length ? SLIDES.map(slideHTML).join('') : '<p class="note">No slides yet — use + Slide.</p>';
    }
    if (thumbs) thumbs.innerHTML = SLIDES.map(thumbHTML).join('') || '<p class="note">Empty</p>';
    show(i);
  }
  function show(n) {
    if (!SLIDES.length) { if (count) count.textContent = '0 / 0'; return; }
    i = Math.max(0, Math.min(SLIDES.length - 1, n));
    var nodes = document.querySelectorAll('#stage .slide');
    for (var k = 0; k < nodes.length; k++) nodes[k].classList.toggle('active', k === i);
    var tb = document.querySelectorAll('#thumbs .thumb');
    for (var q = 0; q < tb.length; q++) tb[q].classList.toggle('on', q === i);
    if (prog) prog.style.width = ((i + 1) / SLIDES.length * 100) + '%';
    if (count) count.textContent = (i + 1) + ' / ' + SLIDES.length;
  }

  function moveSlide(k, d) {
    var j = k + d;
    if (k < 0 || k >= SLIDES.length || j < 0 || j >= SLIDES.length) return;
    collect();
    var t = SLIDES[k]; SLIDES[k] = SLIDES[j]; SLIDES[j] = t;
    i = j;
    render(); push();
  }
  function download(name, text, mime) {
    if (BRIDGE && BRIDGE.download) { BRIDGE.download(name, text, mime).catch(function () {}); return; }
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function mdBody(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    var out = [];
    var kids = d.children;
    if (!kids.length) return String(d.textContent || '').trim();
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      if (el.tagName === 'UL' || el.tagName === 'OL') {
        var lis = el.querySelectorAll('li');
        for (var q = 0; q < lis.length; q++) out.push('- ' + String(lis[q].textContent || '').trim());
      } else out.push(String(el.textContent || '').trim());
    }
    return out.filter(Boolean).join('\n');
  }
  function toMarkdown() {
    return SLIDES.map(function (s) {
      var body = mdBody(s.html);
      return '# ' + s.title + (body ? '\n\n' + body : '') + (s.notes ? '\n\n> ' + s.notes : '');
    }).join('\n\n---\n\n') + '\n';
  }
  function deckHtml() {
    var parts = SLIDES.map(function (s) {
      return '<section style="page-break-after:always;padding:44px 52px;font:16px/1.55 system-ui;color:#20211c;background:#fff">' +
        '<h1 style="font-size:30px;margin:0 0 18px">' + e(s.title) + '</h1>' + (s.html || '') +
        (s.notes ? '<p style="margin-top:22px;color:#6b6a62;font-size:13px">' + e(s.notes) + '</p>' : '') +
        '</section>';
    }).join('\n');
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + e(TITLE) + '</title></head>' +
      '<body style="margin:0;background:#fff">' + parts + '</body></html>';
  }

  document.addEventListener('click', function (ev) {
    var n = ev.target.closest ? ev.target.closest('[data-nav]') : null;
    if (n) {
      if (editing) collect();
      show(i + (n.getAttribute('data-nav') === 'next' ? 1 : -1));
      return;
    }
    var a = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!a) return;
    var act = a.getAttribute('data-act');
    var k = Number(a.getAttribute('data-i') || 0);
    if (act === 'goto') { if (editing) collect(); show(k); return; }
    if (act === 'notes') { document.body.classList.toggle('nopnotes'); a.classList.toggle('on'); return; }
    if (act === 'print') { if (BRIDGE && BRIDGE.print) BRIDGE.print().catch(function () {}); else window.print(); return; }
    if (act === 'full') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      return;
    }
    if (act === 'edit') {
      if (editing) collect();
      editing = !editing;
      a.classList.toggle('on', editing);
      a.textContent = editing ? 'Done' : 'Edit';
      render();
      say(editing ? 'Click any title, body or notes area to type.' : 'Saved.');
      if (!editing) push();
      return;
    }
    if (act === 'aspect') {
      ASPECT = ASPECT === '4:3' ? '16:9' : '4:3';
      a.textContent = ASPECT;
      render(); push(); return;
    }
    if (act === 'add') {
      if (editing) collect();
      SLIDES.splice(i + 1, 0, { title: 'Slide ' + (SLIDES.length + 1), html: '<ul><li>Point one</li></ul>', notes: '' });
      i = i + 1; render(); push(); say('Slide added.'); return;
    }
    if (act === 'dup') {
      if (editing) collect();
      var src = SLIDES[i]; if (!src) return;
      SLIDES.splice(i + 1, 0, { title: src.title + ' copy', html: src.html, notes: src.notes, layout: src.layout });
      i = i + 1; render(); push(); say('Duplicated.'); return;
    }
    if (act === 'del') {
      if (SLIDES.length <= 1) { say('Keep at least one slide.'); return; }
      if (editing) collect();
      SLIDES.splice(i, 1);
      i = Math.max(0, i - 1);
      render(); push(); say('Deleted.'); return;
    }
    if (act === 'up') { moveSlide(i, -1); return; }
    if (act === 'down') { moveSlide(i, 1); return; }
    if (act === 'md') { download(String(TITLE || 'deck').replace(/[^\w.-]+/g, '_') + '.md', toMarkdown(), 'text/markdown'); return; }
    if (act === 'html') { download(String(TITLE || 'deck').replace(/[^\w.-]+/g, '_') + '.html', deckHtml(), 'text/html'); return; }
    if (act === 'drive') {
      if (editing) collect();
      if (!BRIDGE || !BRIDGE.invoke) { say('Save to Drive works from the artifact window (Open button).'); return; }
      say('Uploading to Google Drive…');
      BRIDGE.invoke('autobot:slidesUpload', { name: TITLE, html: deckHtml() }).then(function (r) {
        if (r && r.ok && r.url) say('Saved to Drive: ' + r.url);
        else say((r && r.error) || 'Google Drive is not connected.');
      }).catch(function () { say('Google Drive is not connected.'); });
    }
  });

  // Every inline edit saves itself on blur, the same contract as the design
  // canvas: no "Done" needed, nothing is lost when the window is closed.
  document.addEventListener('focusout', function (ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'ttl') {
      var tv = String(t.textContent || '').trim().slice(0, 120);
      if (tv) { TITLE = tv; push(); say('Saved.'); } else { t.textContent = TITLE; }
      return;
    }
    var sec = t.closest ? t.closest('#stage .slide') : null;
    if (!sec) return;
    var k = Number(sec.getAttribute('data-i') || 0);
    var s = SLIDES[k];
    if (!s) return;
    if (t.classList && t.classList.contains('stitle')) {
      var v = String(t.textContent || '').trim().slice(0, 200);
      if (v) s.title = v; else t.textContent = s.title;
    } else if (t.classList && t.classList.contains('snotes')) {
      s.notes = String(t.textContent || '').trim();
    } else if (t.classList && t.classList.contains('sbody')) {
      s.html = t.innerHTML;
    } else {
      return;
    }
    push();
    if (thumbs && t.classList && t.classList.contains('stitle')) {
      var th = thumbs.querySelectorAll('.thumb')[k];
      var lbl = th && th.querySelector('.ttl');
      if (lbl) lbl.textContent = s.title;
    }
    say('Saved.');
  });

  document.addEventListener('keydown', function (ev) {
    var tag = (ev.target && ev.target.tagName) || '';
    if (editing && (tag === 'H1' || tag === 'DIV' || tag === 'ASIDE' || ev.target.isContentEditable)) return;
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); show(i + 1); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); show(i - 1); }
    else if (ev.key === 'Home') show(0);
    else if (ev.key === 'End') show(SLIDES.length - 1);
    else if (ev.key.toLowerCase() === 'n') document.body.classList.toggle('nopnotes');
    else if (ev.key.toLowerCase() === 'f') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    }
  });

  render();
  syncEdit();
  if (bar) bar.setAttribute('data-ready', '1');
  say('');
}
module.exports = { designRuntime, slidesRuntime };
