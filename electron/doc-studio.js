'use strict';
// Pre-Bundled Zero-Install Office, PDF, ZIP, SQLite, EPUB & LaTeX Engine.
// Works 100% offline with zero external `pip install`, `libreoffice`, or `pdftotext` required.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const docxLib = require('docx');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const AdmZip = require('adm-zip');
const katex = require('katex');

const DOC_EXT_RE = /\.(pdf|docx|xlsx|xls|xlsm|ods|pptx|zip|tar\.gz|tgz|epub|odt|rtf|sqlite|sqlite3|db)$/i;
const ATTACHMENT_EXTRACT_EXT_RE = /\.(pdf|docx|xlsx|xls|ods|pptx|zip|tar\.gz|tgz|epub|odt|rtf|csv|tsv)$/i;

function isDocumentPath(p) {
  return DOC_EXT_RE.test(String(p || '').trim());
}

function isExtractableAttachment(name) {
  return ATTACHMENT_EXTRACT_EXT_RE.test(String(name || '').trim());
}

function parsePageRange(pagesSpec, totalPages) {
  if (!pagesSpec) return null;
  const set = new Set();
  for (const part of String(pagesSpec).split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Math.max(1, parseInt(m[1], 10));
    const b = Math.min(totalPages || 9999, parseInt(m[2] || m[1], 10));
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set.size ? set : null;
}

function decodeHexPdfBytes(hexRaw) {
  const clean = String(hexRaw || '').replace(/\s+/g, '');
  if (!clean) return '';
  const padded = clean.length % 2 ? clean + '0' : clean;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let j = 2; j + 1 < bytes.length; j += 2) {
      out += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
    }
    return out;
  }
  let out = '';
  for (let j = 0; j < bytes.length; j++) {
    const b = bytes[j];
    out += b === 0x95 ? '•' : String.fromCharCode(b);
  }
  return out;
}

function decodePdfLiteralStrings(raw) {
  const chunks = [];
  let inText = false;
  let i = 0;
  while (i < raw.length) {
    if (!inText) {
      if (raw[i] === 'B' && raw[i + 1] === 'T' && /\s/.test(raw[i + 2] || ' ')) {
        inText = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (raw[i] === 'E' && raw[i + 1] === 'T' && /\s|$/.test(raw[i + 2] || ' ')) {
      inText = false;
      chunks.push('\n');
      i += 2;
      continue;
    }
    if (raw[i] === '<' && raw[i + 1] !== '<') {
      const end = raw.indexOf('>', i + 1);
      if (end > i) {
        const dec = decodeHexPdfBytes(raw.slice(i + 1, end));
        if (dec) chunks.push(dec);
        i = end + 1;
        continue;
      }
    }
    if (raw[i] === '(') {
      i++;
      let s = '';
      let depth = 1;
      while (i < raw.length && depth > 0) {
        const ch = raw[i];
        if (ch === '\\' && i + 1 < raw.length) {
          const nx = raw[i + 1];
          if (nx === 'n') s += '\n';
          else if (nx === 'r') s += ' ';
          else if (nx === 't') s += '\t';
          else if (/[0-7]{1,3}/.test(raw.slice(i + 1, i + 4))) {
            const oct = /^([0-7]{1,3})/.exec(raw.slice(i + 1, i + 4))[1];
            s += String.fromCharCode(parseInt(oct, 8));
            i += oct.length + 1;
            continue;
          } else s += nx;
          i += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { i++; break; }
        }
        s += ch;
        i++;
      }
      if (s) chunks.push(s);
      continue;
    }
    i++;
  }
  return chunks.join(' ').replace(/[ \t]+/g, ' ').replace(/\n +/g, '\n').trim();
}

function extractPdfPagesDirect(pdfDoc) {
  const pages = pdfDoc.getPages();
  const out = [];
  for (let idx = 0; idx < pages.length; idx++) {
    const pg = pages[idx];
    const parts = [];
    try {
      const contents = pg.node && typeof pg.node.Contents === 'function' ? pg.node.Contents() : null;
      const arr = contents ? (typeof contents.asArray === 'function' ? contents.asArray() : [contents]) : [];
      for (const ref of arr) {
        const stream = pdfDoc.context.lookup(ref);
        if (!stream || !stream.contents) continue;
        const rawBuf = Buffer.from(stream.contents);
        let decoded = '';
        try { decoded = zlib.inflateSync(rawBuf).toString('latin1'); }
        catch (_) { decoded = rawBuf.toString('latin1'); }
        const extracted = decodePdfLiteralStrings(decoded);
        if (extracted) parts.push(extracted);
      }
    } catch (_) {}
    out.push({ page: idx + 1, text: parts.join('\n').trim() });
  }
  return out;
}

function extractPdfStreamsFallback(buf) {
  const latin = buf.toString('latin1');
  const texts = [];
  let idx = 0;
  while ((idx = latin.indexOf('stream', idx)) !== -1) {
    const startAfter = latin[idx + 6] === '\r' && latin[idx + 7] === '\n'
      ? idx + 8
      : (latin[idx + 6] === '\n' || latin[idx + 6] === '\r' ? idx + 7 : -1);
    if (startAfter < 0) { idx += 6; continue; }
    const endIdx = latin.indexOf('endstream', startAfter);
    if (endIdx < 0) break;
    let body = buf.subarray(startAfter, endIdx);
    while (body.length && (body[body.length - 1] === 0x0a || body[body.length - 1] === 0x0d)) {
      body = body.subarray(0, body.length - 1);
    }
    let decodedStr = '';
    try {
      decodedStr = zlib.inflateSync(body).toString('latin1');
    } catch (_) {
      decodedStr = body.toString('latin1');
    }
    const extracted = decodePdfLiteralStrings(decodedStr);
    if (extracted) texts.push(extracted);
    idx = endIdx + 9;
  }
  return texts.join('\n\n').trim();
}

async function readPdfDocument(buf, opts = {}) {
  const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();
  const wantedPages = parsePageRange(opts.pages, totalPages);
  const directPages = extractPdfPagesDirect(pdfDoc);
  const perPage = [];
  let parsed = null;
  try {
    let pageCounter = 0;
    parsed = await pdfParse(buf, {
      pagerender: (pageData) => pageData.getTextContent().then((tc) => {
        pageCounter++;
        let lastY;
        let text = '';
        for (const item of tc.items || []) {
          if (lastY === item.transform[5] || lastY == null) text += item.str;
          else text += '\n' + item.str;
          lastY = item.transform[5];
        }
        perPage.push({ page: pageCounter, text: text.trim() });
        return text;
      }),
    });
  } catch (_) {}

  const mergedPages = [];
  for (let pNum = 1; pNum <= Math.max(totalPages, perPage.length, directPages.length); pNum++) {
    const pp = perPage.find((x) => x.page === pNum);
    const dp = directPages.find((x) => x.page === pNum);
    const best = (pp && pp.text ? pp.text : '') || (dp && dp.text ? dp.text : '');
    mergedPages.push({ page: pNum, text: best });
  }
  if (mergedPages.every((p) => !p.text)) {
    const fb = (parsed && parsed.text ? String(parsed.text).trim() : '') || extractPdfStreamsFallback(buf);
    if (fb && mergedPages[0]) mergedPages[0].text = fb;
  }

  const pagesOut = mergedPages.filter((p) => !wantedPages || wantedPages.has(p.page));
  const text = pagesOut.map((p) => (totalPages > 1 ? `## Page ${p.page}\n${p.text}` : p.text)).join('\n\n').trim();

  let formFields = {};
  try {
    const form = pdfDoc.getForm();
    for (const f of form.getFields()) {
      const name = f.getName();
      let val = '';
      try { val = typeof f.getText === 'function' ? f.getText() : ''; } catch (_) {}
      formFields[name] = val;
    }
  } catch (_) {}

  return {
    ok: true,
    format: 'pdf',
    pageCount: totalPages,
    pages: pagesOut,
    formFields,
    text,
    markdown: text || `(PDF has ${totalPages} page${totalPages === 1 ? '' : 's'} with no extractable text)`,
  };
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function xmlTextRuns(xml, tag = 'w:t') {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decodeXmlEntities(m[1]));
  return out;
}

async function readDocxDocument(buf) {
  let markdown = '';
  try {
    const r = await mammoth.convertToMarkdown({ buffer: buf });
    if (r && r.value) markdown = r.value.replace(/\\([.\-_!*#()])/g, '$1').trim();
  } catch (_) {}
  const zip = await JSZip.loadAsync(buf);
  const mediaFiles = Object.keys(zip.files).filter((k) => /^word\/media\//i.test(k) && !zip.files[k].dir);
  if (!markdown && zip.files['word/document.xml']) {
    const xml = await zip.files['word/document.xml'].async('string');
    const paras = xml.split(/<\/w:p>/i).map((p) => xmlTextRuns(p, 'w:t').join('').trim()).filter(Boolean);
    markdown = paras.join('\n\n');
  }
  return {
    ok: true,
    format: 'docx',
    text: markdown,
    markdown: markdown || '(empty DOCX)',
    mediaFiles,
  };
}

function sheetToMarkdown(headers, rows) {
  if (!headers.length && !rows.length) return '_(empty sheet)_';
  const cols = headers.length ? headers : (rows[0] || []).map((_, i) => `Col ${i + 1}`);
  const escCell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const line1 = '| ' + cols.map(escCell).join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const body = rows.slice(0, 200).map((r) => '| ' + cols.map((_, i) => escCell(r[i])).join(' | ') + ' |');
  const tail = rows.length > 200 ? `\n\n_(Showing 200 of ${rows.length} rows)_` : '';
  return [line1, sep, ...body].join('\n') + tail;
}

function readSpreadsheetDocument(buf, opts = {}) {
  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellNF: true, cellDates: true });
  const sheetNames = wb.SheetNames || [];
  const wanted = opts.sheet ? sheetNames.filter((n) => n === opts.sheet) : sheetNames;
  const sheets = [];
  const mdParts = [];
  for (const name of wanted) {
    const ws = wb.Sheets[name];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const headers = aoa.length ? aoa[0].map((v) => String(v == null ? '' : v)) : [];
    const rows = aoa.slice(1);
    const formulas = {};
    for (const [addr, cell] of Object.entries(ws)) {
      if (addr.startsWith('!')) continue;
      if (cell && cell.f) formulas[addr] = '=' + cell.f;
    }
    sheets.push({ name, headers, rows, formulas, rowCount: rows.length });
    mdParts.push(`### Sheet: ${name} (${rows.length} rows)\n` + sheetToMarkdown(headers, rows));
  }
  const markdown = mdParts.join('\n\n') || '(empty workbook)';
  return { ok: true, format: 'xlsx', sheetNames, sheets, text: markdown, markdown };
}

async function readPptxDocument(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => parseInt(/slide(\d+)\.xml/i.exec(a)[1], 10) - parseInt(/slide(\d+)\.xml/i.exec(b)[1], 10));
  const slides = [];
  const mdParts = [];
  for (const sPath of slideNames) {
    const num = parseInt(/slide(\d+)\.xml/i.exec(sPath)[1], 10);
    const xml = await zip.files[sPath].async('string');
    const paras = xml.split(/<\/a:p>/i).map((p) => xmlTextRuns(p, 'a:t').join('').trim()).filter(Boolean);
    const title = paras[0] || `Slide ${num}`;
    const body = paras.slice(1);
    const notePath = `ppt/notesSlides/notesSlide${num}.xml`;
    let notes = '';
    if (zip.files[notePath]) {
      const nXml = await zip.files[notePath].async('string');
      notes = xmlTextRuns(nXml, 'a:t').filter((t) => !/^\d+$/.test(t.trim())).join(' ').trim();
    }
    slides.push({ slideNumber: num, title, body, notes });
    mdParts.push(`## Slide ${num}: ${title}\n${body.map((b) => `- ${b}`).join('\n')}${notes ? `\n\n_Notes:_ ${notes}` : ''}`);
  }
  const markdown = mdParts.join('\n\n') || '(empty presentation)';
  return { ok: true, format: 'pptx', slideCount: slides.length, slides, text: markdown, markdown };
}

function parseTarEntries(tarBuf) {
  const entries = [];
  let off = 0;
  while (off + 512 <= tarBuf.length) {
    const hdr = tarBuf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const rawName = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeOct = hdr.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(hdr[156] || 48);
    const prefix = hdr.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseInt(sizeOct || '0', 8) || 0;
    const dataStart = off + 512;
    const data = tarBuf.subarray(dataStart, dataStart + size);
    entries.push({ path: fullName, size, isDirectory: typeFlag === '5' || fullName.endsWith('/'), data });
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function assertSafeArchiveEntryPath(entryName, destRoot) {
  const rel = String(entryName || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`Blocked zip-slip path traversal: ${entryName}`);
  }
  const segs = rel.split('/');
  if (segs.some((s) => s === '..')) {
    throw new Error(`Blocked zip-slip path traversal: ${entryName}`);
  }
  const root = path.resolve(destRoot);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Blocked zip-slip path traversal: ${entryName}`);
  }
  return target;
}

function extractArchive(archivePath, destDir) {
  const absArchive = path.resolve(archivePath);
  const absDest = path.resolve(destDir);
  fs.mkdirSync(absDest, { recursive: true });
  const extracted = [];
  if (/\.(tar\.gz|tgz)$/i.test(absArchive)) {
    const tarBuf = zlib.gunzipSync(fs.readFileSync(absArchive));
    for (const ent of parseTarEntries(tarBuf)) {
      const target = assertSafeArchiveEntryPath(ent.path, absDest);
      if (ent.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, ent.data);
        extracted.push(target);
      }
    }
    return { ok: true, destDir: absDest, count: extracted.length, files: extracted };
  }
  const zip = new AdmZip(absArchive);
  for (const ent of zip.getEntries()) {
    const target = assertSafeArchiveEntryPath(ent.entryName, absDest);
    if (ent.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, ent.getData());
      extracted.push(target);
    }
  }
  return { ok: true, destDir: absDest, count: extracted.length, files: extracted };
}

async function readArchiveDocument(buf, ext, opts = {}) {
  let entries = [];
  let preview = '';
  if (ext === '.tar.gz' || ext === '.tgz') {
    const tarBuf = zlib.gunzipSync(buf);
    const parsed = parseTarEntries(tarBuf);
    entries = parsed.map((e) => ({ path: e.path, size: e.size, isDirectory: e.isDirectory }));
    if (opts.entry) {
      const hit = parsed.find((e) => e.path === opts.entry || e.path.endsWith('/' + opts.entry));
      if (hit && !hit.isDirectory) preview = hit.data.toString('utf8');
    }
  } else {
    const zip = await JSZip.loadAsync(buf);
    for (const [p, f] of Object.entries(zip.files)) {
      entries.push({
        path: p,
        size: (f._data && f._data.uncompressedSize) || 0,
        isDirectory: !!f.dir,
      });
    }
    if (opts.entry) {
      const hit = zip.files[opts.entry] || Object.values(zip.files).find((f) => f.name.endsWith('/' + opts.entry));
      if (hit && !hit.dir) preview = await hit.async('string');
    }
  }
  const treeLines = entries.slice(0, 200).map((e) => `- ${e.path}${e.isDirectory ? '/' : ` (${e.size} bytes)`}`);
  const markdown = (opts.entry && preview)
    ? `### Archive entry: ${opts.entry}\n\n${preview}`
    : `### Archive (${entries.length} entries)\n${treeLines.join('\n')}`;
  return { ok: true, format: ext.replace(/^\./, ''), entryCount: entries.length, entries, preview, text: markdown, markdown };
}

function stripXmlTags(htmlOrXml) {
  return decodeXmlEntities(
    String(htmlOrXml || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

async function readEpubOrOdt(buf, ext) {
  const zip = await JSZip.loadAsync(buf);
  if (ext === '.odt' && zip.files['content.xml']) {
    const txt = stripXmlTags(await zip.files['content.xml'].async('string'));
    return { ok: true, format: 'odt', text: txt, markdown: txt };
  }
  const htmlKeys = Object.keys(zip.files).filter((k) => /\.(x?html?|xml)$/i.test(k) && !/META-INF/i.test(k));
  const chapters = [];
  for (const k of htmlKeys.slice(0, 30)) {
    const raw = await zip.files[k].async('string');
    const clean = stripXmlTags(raw);
    if (clean) chapters.push(`## ${path.basename(k)}\n${clean}`);
  }
  const md = chapters.join('\n\n');
  return { ok: true, format: 'epub', text: md, markdown: md || '(empty EPUB)' };
}

function readRtfDocument(buf) {
  const raw = buf.toString('latin1');
  const txt = raw
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, '\t')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { ok: true, format: 'rtf', text: txt, markdown: txt };
}

async function readSqliteDocument(buf) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(buf));
  try {
    const tablesRes = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    const tables = [];
    const md = [];
    if (tablesRes[0]) {
      for (const row of tablesRes[0].values) {
        const name = String(row[0]);
        const ddl = String(row[1] || '');
        const sampleRes = db.exec(`SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT 10`);
        const cols = sampleRes[0] ? sampleRes[0].columns : [];
        const rows = sampleRes[0] ? sampleRes[0].values : [];
        tables.push({ name, ddl, columns: cols, rows });
        md.push(`### Table: ${name}\n\`\`\`sql\n${ddl}\n\`\`\`\n` + sheetToMarkdown(cols, rows));
      }
    }
    const markdown = md.join('\n\n') || '(SQLite database has no user tables)';
    return { ok: true, format: 'sqlite', tables, text: markdown, markdown };
  } finally {
    db.close();
  }
}

async function readDocument(inputPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const fp = path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
  if (!fs.existsSync(fp)) throw new Error(`Document not found: ${fp}`);
  const buf = fs.readFileSync(fp);
  const lower = fp.toLowerCase();
  let res;
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) res = { path: fp, ...(await readArchiveDocument(buf, '.tar.gz', opts)) };
  else {
    const ext = path.extname(lower);
    if (ext === '.pdf') res = { path: fp, ...(await readPdfDocument(buf, opts)) };
    else if (ext === '.docx') res = { path: fp, ...(await readDocxDocument(buf)) };
    else if (['.xlsx', '.xls', '.xlsm', '.csv', '.tsv', '.ods'].includes(ext)) res = { path: fp, ...readSpreadsheetDocument(buf, opts) };
    else if (ext === '.pptx') res = { path: fp, ...(await readPptxDocument(buf)) };
    else if (ext === '.zip') res = { path: fp, ...(await readArchiveDocument(buf, '.zip', opts)) };
    else if (ext === '.epub' || ext === '.odt') res = { path: fp, ...(await readEpubOrOdt(buf, ext)) };
    else if (ext === '.rtf') res = { path: fp, ...readRtfDocument(buf) };
    else if (ext === '.sqlite' || ext === '.sqlite3' || ext === '.db') res = { path: fp, ...(await readSqliteDocument(buf)) };
    else {
      const text = buf.toString('utf8');
      res = { path: fp, ok: true, format: ext.slice(1) || 'txt', text, markdown: text };
    }
  }
  if (opts.extract_images && ['.docx', '.pptx', '.epub', '.odt'].includes(path.extname(lower))) {
    try {
      const zip = await JSZip.loadAsync(buf);
      const imgEntries = Object.keys(zip.files).filter((k) => /\.(png|jpe?g|webp|gif|svg|emf|wmf)$/i.test(k));
      res.images = imgEntries;
      res.imageCount = imgEntries.length;
    } catch (_) {
      res.images = [];
      res.imageCount = 0;
    }
  }
  return res;
}

function wrapTextToLines(text, maxWidth, font, fontSize) {
  const paragraphs = String(text || '').split(/\r?\n/);
  const lines = [];
  for (const para of paragraphs) {
    if (!para.trim()) { lines.push(''); continue; }
    const words = para.split(/\s+/);
    let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(cand, fontSize) <= maxWidth) {
        cur = cand;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

function parseMarkdownBlocks(md) {
  const lines = String(md || '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i++;
      }
      blocks.push({ type: 'bullets', items });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1])) {
      const parseRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }
    if (line.trim()) {
      blocks.push({ type: 'paragraph', text: line.trim() });
    }
    i++;
  }
  return blocks;
}

function latexToReadableText(tex) {
  let s = String(tex || '');
  const titleMatch = /\\title\{([^}]*)\}/.exec(s);
  const authorMatch = /\\author\{([^}]*)\}/.exec(s);
  const bodyMatch = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(s);
  const body = bodyMatch ? bodyMatch[1] : s;
  const lines = [];
  if (titleMatch) lines.push(`# ${titleMatch[1].trim()}`);
  if (authorMatch) lines.push(`Author: ${authorMatch[1].trim()}`);
  const clean = body
    .replace(/\\maketitle/g, '')
    .replace(/\\section\*?\{([^}]*)\}/g, '\n# $1\n')
    .replace(/\\subsection\*?\{([^}]*)\}/g, '\n## $1\n')
    .replace(/\\textbf\{([^}]*)\}/g, '$1')
    .replace(/\\textit\{([^}]*)\}/g, '$1')
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1)/($2)')
    .replace(/\\sqrt\{([^}]*)\}/g, 'sqrt($1)')
    .replace(/\\alpha/g, 'alpha').replace(/\\beta/g, 'beta').replace(/\\gamma/g, 'gamma')
    .replace(/\\sum/g, 'SUM').replace(/\\int/g, 'INT').replace(/\\pi/g, 'pi')
    .replace(/\\item\s+/g, '\n- ')
    .replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, '\n')
    .replace(/\\([a-zA-Z]+)\*?(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\$\$/g, '')
    .replace(/\$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (clean) lines.push(clean);
  return {
    title: titleMatch ? titleMatch[1].trim() : 'LaTeX Document',
    markdown: lines.join('\n\n'),
  };
}

async function generatePdfDocument(args, outPath) {
  // Merge mode
  if (Array.isArray(args.merge_paths) && args.merge_paths.length) {
    const merged = await PDFDocument.create();
    for (const srcRaw of args.merge_paths) {
      const srcPath = path.isAbsolute(srcRaw) ? srcRaw : path.resolve(args.cwd || process.cwd(), srcRaw);
      const srcDoc = await PDFDocument.load(fs.readFileSync(srcPath));
      const copied = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      for (const p of copied) merged.addPage(p);
    }
    fs.writeFileSync(outPath, await merged.save({ useObjectStreams: false }));
    return { pageCount: merged.getPageCount() };
  }

  // Watermark / Stamp / Split existing PDF
  if (args.input_path) {
    const srcPath = path.isAbsolute(args.input_path) ? args.input_path : path.resolve(args.cwd || process.cwd(), args.input_path);
    const pdfDoc = await PDFDocument.load(fs.readFileSync(srcPath));
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    if (args.watermark) {
      for (const p of pages) {
        const { width, height } = p.getSize();
        p.drawText(String(args.watermark), {
          x: width * 0.22,
          y: height * 0.48,
          size: 42,
          font,
          color: rgb(0.45, 0.55, 0.5),
          opacity: 0.28,
          rotate: degrees(35),
        });
      }
    }
    if (args.stamp_page_numbers) {
      pages.forEach((p, idx) => {
        const { width } = p.getSize();
        p.drawText(`Page ${idx + 1} of ${pages.length}`, { x: width / 2 - 36, y: 24, size: 10, font, color: rgb(0.35, 0.4, 0.38) });
      });
    }
    fs.writeFileSync(outPath, await pdfDoc.save({ useObjectStreams: false }));
    return { pageCount: pdfDoc.getPageCount() };
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let page = pdfDoc.addPage([612, 792]);
  let y = 740;
  const left = 54;
  const maxW = 504;

  const ensureSpace = (needed = 24) => {
    if (y - needed < 54) {
      page = pdfDoc.addPage([612, 792]);
      y = 740;
    }
  };

  if (args.title) {
    page.drawText(String(args.title), { x: left, y, size: 22, font: bold, color: rgb(0.05, 0.35, 0.25) });
    y -= 34;
  }

  const blocks = args.sections
    ? args.sections.map((s) => ({ type: 'heading', level: 2, text: s.heading || s.title || '', body: s.body || s.text || '' }))
    : parseMarkdownBlocks(args.markdown || args.content || args.text || '');

  for (const b of blocks) {
    if (b.type === 'heading') {
      ensureSpace(32);
      const sz = b.level === 1 ? 18 : (b.level === 2 ? 15 : 13);
      for (const ln of wrapTextToLines(b.text, maxW, bold, sz)) {
        ensureSpace(sz + 8);
        page.drawText(ln, { x: left, y, size: sz, font: bold, color: rgb(0.1, 0.14, 0.12) });
        y -= sz + 7;
      }
      if (b.body) {
        for (const ln of wrapTextToLines(b.body, maxW, font, 11)) {
          ensureSpace(18);
          if (ln) page.drawText(ln, { x: left, y, size: 11, font, color: rgb(0.18, 0.22, 0.2) });
          y -= 16;
        }
      }
    } else if (b.type === 'bullets') {
      for (const item of b.items) {
        const lines = wrapTextToLines(`• ${item}`, maxW - 12, font, 11);
        for (const ln of lines) {
          ensureSpace(16);
          page.drawText(ln, { x: left + 12, y, size: 11, font, color: rgb(0.18, 0.22, 0.2) });
          y -= 16;
        }
      }
    } else if (b.type === 'table') {
      const rowText = (r) => r.join('  |  ');
      ensureSpace(20);
      page.drawText(rowText(b.headers), { x: left, y, size: 10, font: bold, color: rgb(0.06, 0.3, 0.22) });
      y -= 16;
      for (const r of b.rows) {
        ensureSpace(16);
        page.drawText(rowText(r), { x: left, y, size: 10, font, color: rgb(0.2, 0.22, 0.22) });
        y -= 15;
      }
      y -= 6;
    } else {
      for (const ln of wrapTextToLines(b.text, maxW, font, 11)) {
        ensureSpace(16);
        if (ln) page.drawText(ln, { x: left, y, size: 11, font, color: rgb(0.18, 0.22, 0.2) });
        y -= 16;
      }
      y -= 4;
    }
  }

  if (args.watermark) {
    for (const p of pdfDoc.getPages()) {
      p.drawText(String(args.watermark), { x: 140, y: 380, size: 36, font: bold, color: rgb(0.5, 0.6, 0.55), opacity: 0.25, rotate: degrees(35) });
    }
  }

  fs.writeFileSync(outPath, await pdfDoc.save({ useObjectStreams: false }));
  return { pageCount: pdfDoc.getPageCount() };
}

async function generateLatexPdf(args, outPath) {
  const tex = String(args.latex || args.tex || args.content || args.markdown || '');
  // Try system tectonic / pdflatex if installed
  for (const cmd of ['tectonic', 'pdflatex', 'xelatex']) {
    try {
      const bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
      if (bin && fs.existsSync(bin)) {
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-tex-'));
        const texFile = path.join(workDir, 'doc.tex');
        fs.writeFileSync(texFile, tex, 'utf8');
        try {
          if (cmd === 'tectonic') execFileSync(bin, [texFile], { cwd: workDir, timeout: 25000, stdio: 'pipe' });
          else execFileSync(bin, ['-interaction=nonstopmode', '-output-directory', workDir, texFile], { cwd: workDir, timeout: 25000, stdio: 'pipe' });
          const produced = path.join(workDir, 'doc.pdf');
          if (fs.existsSync(produced)) {
            fs.copyFileSync(produced, outPath);
            fs.rmSync(workDir, { recursive: true, force: true });
            return { compiler: cmd, pageCount: 1 };
          }
        } catch (_) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (__) {}
        }
      }
    } catch (_) {}
  }

  // Offline fallback: verify KaTeX renders inline math if present, and build clean PDF via pdf-lib
  try {
    const mathMatch = /\$([^$]+)\$/.exec(tex);
    if (mathMatch) katex.renderToString(mathMatch[1], { throwOnError: false });
  } catch (_) {}
  const parsed = latexToReadableText(tex);
  const res = await generatePdfDocument({ ...args, title: args.title || parsed.title, markdown: parsed.markdown }, outPath);
  return { compiler: 'akron-katex-pdf-fallback', ...res };
}

async function generateDocxDocument(args, outPath) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType, Header, Footer } = docxLib;
  const children = [];
  if (args.title) {
    children.push(new Paragraph({ text: String(args.title), heading: HeadingLevel.TITLE }));
  }
  const blocks = parseMarkdownBlocks(args.markdown || args.content || args.text || '');
  for (const b of blocks) {
    if (b.type === 'heading') {
      const lvl = b.level === 1 ? HeadingLevel.HEADING_1 : (b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3);
      children.push(new Paragraph({ text: b.text, heading: lvl }));
    } else if (b.type === 'bullets') {
      for (const item of b.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
      }
    } else if (b.type === 'table') {
      const makeRow = (cells, isHdr) => new TableRow({
        children: cells.map((c) => new TableCell({
          width: { size: Math.floor(100 / Math.max(1, cells.length)), type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: String(c), bold: !!isHdr })] })],
        })),
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [makeRow(b.headers, true), ...b.rows.map((r) => makeRow(r, false))],
      }));
    } else {
      children.push(new Paragraph({ text: b.text }));
    }
  }
  if (!children.length) children.push(new Paragraph({ text: String(args.title || 'Akron Document') }));
  const doc = new Document({
    sections: [{
      headers: args.header ? { default: new Header({ children: [new Paragraph({ text: String(args.header) })] }) } : undefined,
      footers: args.footer ? { default: new Footer({ children: [new Paragraph({ text: String(args.footer) })] }) } : undefined,
      children,
    }],
  });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  return { size: buf.length };
}

function evalSimpleExcelFormula(ws, expr) {
  const m = /^(SUM|AVERAGE|MIN|MAX)\(([A-Z]+)(\d+):([A-Z]+)(\d+)\)$/i.exec(String(expr || '').trim());
  if (!m) return 0;
  const fn = m[1].toUpperCase();
  const c1 = XLSX.utils.decode_col(m[2].toUpperCase());
  const r1 = parseInt(m[3], 10) - 1;
  const c2 = XLSX.utils.decode_col(m[4].toUpperCase());
  const r2 = parseInt(m[5], 10) - 1;
  const nums = [];
  for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === 'number') nums.push(cell.v);
    }
  }
  if (!nums.length) return 0;
  if (fn === 'SUM') return nums.reduce((a, b) => a + b, 0);
  if (fn === 'AVERAGE') return nums.reduce((a, b) => a + b, 0) / nums.length;
  if (fn === 'MIN') return Math.min(...nums);
  if (fn === 'MAX') return Math.max(...nums);
  return 0;
}

function generateXlsxDocument(args, outPath) {
  const wb = XLSX.utils.book_new();
  const sheets = Array.isArray(args.sheets) && args.sheets.length
    ? args.sheets
    : [{ name: args.sheetName || 'Sheet1', columns: args.columns || [], rows: args.rows || [] }];

  for (const s of sheets) {
    const name = String(s.name || 'Sheet').slice(0, 31);
    const cols = Array.isArray(s.columns) ? s.columns : [];
    const rows = Array.isArray(s.rows) ? s.rows : [];
    const aoa = cols.length ? [cols, ...rows] : rows;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Upgrade formula strings ("=SUM(...)") and formula objects ({ formula, numFmt })
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const srcRow = aoa[r];
        const rawVal = srcRow ? srcRow[c] : undefined;
        const addr = XLSX.utils.encode_cell({ r, c });
        if (typeof rawVal === 'string' && rawVal.startsWith('=')) {
          const fExpr = rawVal.slice(1);
          ws[addr] = { t: 'n', v: evalSimpleExcelFormula(ws, fExpr), f: fExpr };
        } else if (rawVal && typeof rawVal === 'object' && rawVal.formula) {
          const fExpr = String(rawVal.formula).replace(/^=/, '');
          const v = rawVal.value != null ? rawVal.value : evalSimpleExcelFormula(ws, fExpr);
          ws[addr] = { t: 'n', v, f: fExpr, z: rawVal.numFmt || undefined };
        }
      }
    }
    // Auto-size columns + freeze header row
    ws['!cols'] = (cols.length ? cols : (aoa[0] || [])).map((h, ci) => {
      let maxW = String(h || '').length;
      for (const r of rows) maxW = Math.max(maxW, String((r && r[ci]) || '').length);
      return { wch: Math.min(48, Math.max(10, maxW + 3)) };
    });
    if (s.freezeHeader !== false && cols.length) {
      ws['!views'] = [{ state: 'frozen', ySplit: 1 }];
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, outPath);
  return { sheetCount: sheets.length };
}

async function generatePptxDocument(args, outPath) {
  const pptx = new PptxGenJS();
  pptx.layout = args.aspect === '4:3' ? 'LAYOUT_4x3' : 'LAYOUT_WIDE';
  if (args.title) pptx.title = String(args.title);

  const rawSlides = Array.isArray(args.slides) && args.slides.length
    ? args.slides
    : [{ title: args.title || 'Presentation', bullets: args.bullets || [args.content || 'Generated by Akron Code'] }];

  for (let i = 0; i < rawSlides.length; i++) {
    const s = rawSlides[i] || {};
    const slide = pptx.addSlide();
    slide.background = { color: i === 0 ? '0C1713' : 'F4FAF7' };
    const fg = i === 0 ? 'ECFDF5' : '0F172A';
    const accent = '10B981';

    slide.addText(String(s.title || `Slide ${i + 1}`), {
      x: 0.6, y: 0.45, w: 12.1, h: 0.7,
      fontSize: i === 0 ? 30 : 24, bold: true, color: fg,
    });
    if (s.subtitle) {
      slide.addText(String(s.subtitle), { x: 0.6, y: 1.15, w: 12.1, h: 0.45, fontSize: 15, color: accent });
    }
    const bullets = Array.isArray(s.bullets) ? s.bullets : (s.body ? String(s.body).split(/\r?\n/).filter(Boolean) : []);
    if (bullets.length) {
      slide.addText(
        bullets.map((b) => ({ text: String(b), options: { bullet: true } })),
        { x: 0.65, y: s.subtitle ? 1.7 : 1.3, w: 11.8, h: 4.5, fontSize: 16, color: fg, valign: 'top' }
      );
    }
    if (Array.isArray(s.table) && s.table.length) {
      slide.addTable(s.table.map((row) => row.map((cell) => ({ text: String(cell == null ? '' : cell) }))), {
        x: 0.6, y: 2.2, w: 12.0, fontSize: 12, color: '0F172A',
      });
    }
    if (s.notes) {
      slide.addNotes(String(s.notes));
    }
  }
  await pptx.writeFile({ fileName: outPath });
  return { slideCount: rawSlides.length };
}

async function generateZipArchive(args, outPath) {
  const zip = new JSZip();
  const cwd = args.cwd || process.cwd();
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === 'string') {
        const abs = path.isAbsolute(f) ? f : path.resolve(cwd, f);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          zip.file(path.basename(abs), fs.readFileSync(abs));
        }
      } else if (f && f.name) {
        zip.file(String(f.name).replace(/^[/\\]+/, ''), String(f.content == null ? '' : f.content));
      }
    }
  }
  if (args.source_dir) {
    const dir = path.isAbsolute(args.source_dir) ? args.source_dir : path.resolve(cwd, args.source_dir);
    const walk = (d, relBase) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        const full = path.join(d, ent.name);
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(full, rel);
        else zip.file(rel, fs.readFileSync(full));
      }
    };
    if (fs.existsSync(dir)) walk(dir, '');
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outPath, buf);
  return { entryCount: Object.keys(zip.files).length, size: buf.length };
}

async function generateDocument(rawArgs = {}, ctx = {}) {
  const args = (rawArgs && rawArgs.spec && typeof rawArgs.spec === 'object' && !Array.isArray(rawArgs.spec))
    ? { ...rawArgs.spec, ...rawArgs }
    : (rawArgs || {});
  const cwd = args.cwd || ctx.cwd || process.cwd();
  const outRaw = args.output_path || args.path || '';
  const fmt = String(args.format || (outRaw ? path.extname(outRaw).slice(1) : '') || 'pdf').toLowerCase().replace(/^\./, '');
  const resolvedFmt = (fmt === 'tex' || fmt === 'latex' || fmt === 'latex_pdf') ? 'pdf' : fmt;
  const dest = outRaw
    ? (path.isAbsolute(outRaw) ? path.normalize(outRaw) : path.resolve(cwd, outRaw))
    : path.join(cwd || os.tmpdir(), '.akron-studio', `doc-${crypto.randomBytes(3).toString('hex')}.${resolvedFmt}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let meta = {};
  if (fmt === 'tex' || fmt === 'latex' || fmt === 'latex_pdf' || args.latex || args.tex) {
    meta = await generateLatexPdf({ ...args, cwd }, dest);
  } else if (resolvedFmt === 'pdf') {
    meta = await generatePdfDocument({ ...args, cwd }, dest);
  } else if (resolvedFmt === 'docx') {
    meta = await generateDocxDocument({ ...args, cwd }, dest);
  } else if (resolvedFmt === 'xlsx' || resolvedFmt === 'csv') {
    meta = generateXlsxDocument({ ...args, cwd }, dest);
  } else if (resolvedFmt === 'pptx') {
    meta = await generatePptxDocument({ ...args, cwd }, dest);
  } else if (resolvedFmt === 'zip') {
    meta = await generateZipArchive({ ...args, cwd }, dest);
  } else {
    throw new Error(`Unsupported GenerateDocument format: ${fmt}`);
  }

  const stat = fs.statSync(dest);
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'mediaArtifact', kind: 'document', format: resolvedFmt, files: [dest], path: dest, size: stat.size, ...meta });
  }
  return {
    ok: true,
    format: resolvedFmt,
    path: dest,
    files: [dest],
    size: stat.size,
    ...meta,
    summary: `Generated ${resolvedFmt.toUpperCase()} document (${stat.size} bytes) → ${dest}`,
  };
}

async function extractAttachmentFile({ path: filePath, name, buffer } = {}) {
  const fname = name || (filePath ? path.basename(filePath) : 'attachment');
  if (!isExtractableAttachment(fname)) return null;
  const buf = buffer ? Buffer.from(buffer) : (filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
  if (!buf) return null;
  const lower = fname.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    const parsed = readSpreadsheetDocument(buf);
    return { name: fname, isText: true, format: lower.slice(-3), content: parsed.markdown.slice(0, 120000), meta: { sheetCount: parsed.sheetNames.length } };
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    const res = await readArchiveDocument(buf, '.tar.gz', {});
    return { name: fname, isText: true, format: 'tar.gz', content: res.markdown.slice(0, 120000), meta: { entryCount: res.entryCount } };
  }
  const ext = path.extname(lower);
  let res = null;
  if (ext === '.pdf') res = await readPdfDocument(buf, {});
  else if (ext === '.docx') res = await readDocxDocument(buf);
  else if (['.xlsx', '.xls', '.ods'].includes(ext)) res = readSpreadsheetDocument(buf, {});
  else if (ext === '.pptx') res = await readPptxDocument(buf);
  else if (ext === '.zip') res = await readArchiveDocument(buf, '.zip', {});
  else if (ext === '.epub' || ext === '.odt') res = await readEpubOrOdt(buf, ext);
  else if (ext === '.rtf') res = readRtfDocument(buf);
  if (!res) return null;
  return {
    name: fname,
    isText: true,
    format: res.format || ext.slice(1),
    content: String(res.markdown || res.text || '').slice(0, 120000),
    meta: { pageCount: res.pageCount, slideCount: res.slideCount, entryCount: res.entryCount },
  };
}

module.exports = {
  isDocumentPath,
  isExtractableAttachment,
  readDocument,
  generateDocument,
  extractArchive,
  extractAttachmentFile,
  assertSafeArchiveEntryPath,
};
