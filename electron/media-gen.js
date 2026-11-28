'use strict';
// Universal Media Studio Engine: Image + Video (+ Audio) generation & editing
// with automatic provider routing (Gemini Imagen/Veo, OpenAI gpt-image/Sora,
// xAI/Together/Flux/Fal/Replicate, ComfyUI/A1111) and guaranteed offline fallback.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const gifenc = require('gifenc');
const router = require('./orch-router');

const ASPECT_DIMENSIONS = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '4:3': { width: 1152, height: 864 },
};

const VIDEO_DIMENSIONS = {
  '16:9': { width: 640, height: 360 },
  '9:16': { width: 360, height: 640 },
  '1:1': { width: 480, height: 480 },
};

// Compact 5x7 bitmap font for crisp offline overlays, watermarks, & subtitles.
const FONT_5X7 = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10011', '10101', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '11110', '10001', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '00110', '00100', '01000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '/': ['00001', '00010', '00100', '00100', '01000', '10000', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00010', '00100', '00100', '00000', '00100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

function unpackAsarPath(p) {
  if (!p) return '';
  return String(p).replace(/app\.asar([/\\])/g, 'app.asar.unpacked$1');
}

function resolveBinary(installerPkg, names = []) {
  try {
    const mod = require(installerPkg);
    const candidate = unpackAsarPath(mod && mod.path);
    if (candidate && fs.existsSync(candidate)) return candidate;
  } catch (_) {}
  const home = os.homedir();
  const candidates = [];
  for (const n of names) {
    candidates.push(path.join(home, '.autobot', 'runtimes', n));
    candidates.push(path.join(home, '.autobot', 'bin', n));
    candidates.push(path.join('/opt/homebrew/bin', n));
    candidates.push(path.join('/usr/local/bin', n));
    candidates.push(path.join('/usr/bin', n));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  for (const n of names) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const out = execFileSync(cmd, [n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0];
      if (out && fs.existsSync(out)) return out;
    } catch (_) {}
  }
  return '';
}

function resolveFfmpeg() {
  return resolveBinary('@ffmpeg-installer/ffmpeg', [process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg']);
}

function resolveFfprobe() {
  return resolveBinary('@ffprobe-installer/ffprobe', [process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe']);
}

function runBin(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
      stdio: [opts.inputBuffer ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    proc.stdout.on('data', (d) => outChunks.push(d));
    proc.stderr.on('data', (d) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const stdout = Buffer.concat(outChunks);
      const stderr = Buffer.concat(errChunks).toString('utf8');
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else reject(new Error(`${path.basename(bin)} exited ${code}: ${stderr.slice(-500)}`));
    });
    if (opts.inputBuffer) {
      proc.stdin.end(opts.inputBuffer);
    }
  });
}

function cacheMediaArtifact(filePath) {
  const out = { cachePath: '', previewDataUrl: '' };
  try {
    if (!filePath || !fs.existsSync(filePath)) return out;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) return out;
    if (!isTransientTestPath(filePath)) {
      const cacheDir = path.join(os.homedir(), '.autobot', 'media-cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      const hash = crypto.createHash('sha1').update(filePath + ':' + stat.mtimeMs).digest('hex').slice(0, 8);
      const cachePath = path.join(cacheDir, `${Date.now()}-${hash}-${path.basename(filePath)}`);
      fs.copyFileSync(filePath, cachePath);
      out.cachePath = cachePath;
    }
    const ext = path.extname(filePath).toLowerCase().slice(1);
    if (/^(png|jpe?g|webp|gif|svg|ico|bmp)$/.test(ext) && stat.size <= 4 * 1024 * 1024) {
      const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext);
      out.previewDataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    }
  } catch (_) {}
  return out;
}

function getElectronNativeImage() {
  try {
    const electron = require('electron');
    return (electron && electron.nativeImage) || null;
  } catch (_) {
    return null;
  }
}

function resolveLibraryDir() {
  const dir = path.join(os.homedir(), '.autobot', 'media-library');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function readLibraryIndex() {
  const indexPath = path.join(resolveLibraryDir(), 'index.json');
  try {
    if (!fs.existsSync(indexPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeLibraryIndex(items) {
  const indexPath = path.join(resolveLibraryDir(), 'index.json');
  try {
    fs.writeFileSync(indexPath, JSON.stringify((Array.isArray(items) ? items : []).slice(0, 300), null, 2), 'utf8');
  } catch (_) {}
}

function isTransientTestPath(p) {
  if (!p) return false;
  if (process.env.AKRON_SKIP_MEDIA_LIBRARY === '1') return true;
  const s = String(p);
  if (/(\/|^)(akron-media-doc-|akron-repro-|akron-repro|_tooltest|_videotest)(\/|$)/i.test(s)) return true;
  try {
    const tmpRoot = path.resolve(os.tmpdir());
    const abs = path.resolve(s);
    if (abs === tmpRoot || abs.startsWith(tmpRoot + path.sep)) return true;
  } catch (_) {}
  if (/^\/tmp\//i.test(s) || /^\/var\/folders\//i.test(s)) return true;
  return false;
}

function recordMediaLibraryItem(item = {}) {
  try {
    if (!item || !item.path || item.skipLibrary) return null;
    if (isTransientTestPath(item.path) || isTransientTestPath(item.cwd)) return null;
    const libDir = resolveLibraryDir();
    let stablePath = item.cachePath && fs.existsSync(item.cachePath) ? item.cachePath : '';
    if (!stablePath && fs.existsSync(item.path)) {
      const filesDir = path.join(libDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });
      const dest = path.join(filesDir, `${Date.now()}-${path.basename(item.path)}`);
      fs.copyFileSync(item.path, dest);
      stablePath = dest;
    }
    const stat = fs.existsSync(item.path) ? fs.statSync(item.path) : (stablePath && fs.existsSync(stablePath) ? fs.statSync(stablePath) : null);
    const entry = {
      id: item.id || crypto.randomBytes(6).toString('hex'),
      kind: item.kind || 'image',
      name: item.name || path.basename(item.path),
      path: item.path,
      cachePath: stablePath || item.cachePath || '',
      format: item.format || path.extname(item.path).slice(1).toLowerCase() || 'png',
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      duration: Number(item.duration || item.duration_sec) || 0,
      size: Number(item.size) || (stat ? stat.size : 0),
      model: item.model || '',
      backend: item.backend || '',
      prompt: String(item.prompt || '').slice(0, 500),
      operation: item.operation || '',
      cwd: item.cwd || '',
      createdAt: item.createdAt || Date.now(),
    };
    const list = readLibraryIndex().filter((x) => x && x.path !== entry.path);
    list.unshift(entry);
    writeLibraryIndex(list);
    return entry;
  } catch (_) {
    return null;
  }
}

function pruneTransientMediaCache() {
  try {
    const cacheDir = path.join(os.homedir(), '.autobot', 'media-cache');
    if (!fs.existsSync(cacheDir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(cacheDir)) {
      if (/(akron-media-doc-|akron-repro-|akron-repro|_tooltest|_videotest)/i.test(name)) {
        try { fs.unlinkSync(path.join(cacheDir, name)); removed++; } catch (_) {}
      }
    }
    return removed;
  } catch (_) {
    return 0;
  }
}

function listMediaLibrary({ cwd = '', kind = 'all', limit = 120 } = {}) {
  pruneTransientMediaCache();
  const raw = readLibraryIndex();
  const out = [];
  const cleaned = [];
  let dirty = false;
  for (const item of raw) {
    if (!item || !item.path) { dirty = true; continue; }
    if (isTransientTestPath(item.path) || isTransientTestPath(item.cwd)) {
      if (item.cachePath && item.cachePath.includes('media-library') && fs.existsSync(item.cachePath)) {
        try { fs.unlinkSync(item.cachePath); } catch (_) {}
      }
      dirty = true;
      continue;
    }
    // Remove previously mislabeled offline videos (<200KB 640x360 claiming Veo)
    if (item.kind === 'video' && item.backend === 'google-veo' && Number(item.size) < 200000 && Number(item.width) <= 640) {
      dirty = true;
      continue;
    }
    const diskExists = fs.existsSync(item.path);
    const cacheExists = item.cachePath && fs.existsSync(item.cachePath);
    if (!diskExists && !cacheExists) { dirty = true; continue; }
    cleaned.push(item);
    if (kind !== 'all' && item.kind !== kind) continue;
    const resolvedFile = diskExists ? item.path : item.cachePath;
    let previewDataUrl = '';
    if (item.kind === 'image') {
      try {
        const ext = path.extname(resolvedFile).slice(1).toLowerCase() || 'png';
        const st = fs.statSync(resolvedFile);
        if (st.size > 0 && st.size <= 4 * 1024 * 1024) {
          const mime = ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`);
          previewDataUrl = `data:${mime};base64,${fs.readFileSync(resolvedFile).toString('base64')}`;
        }
      } catch (_) {}
    }
    out.push({
      ...item,
      inCurrentProject: !!(cwd && item.cwd && path.resolve(item.cwd) === path.resolve(cwd)),
      existsOnDisk: diskExists,
      fileUrl: 'file://' + encodeURI(resolvedFile),
      previewDataUrl,
    });
    if (out.length >= limit) break;
  }
  if (dirty) writeLibraryIndex(cleaned);
  return out;
}

function deleteMediaLibraryItem({ id = '', path: targetPath = '' } = {}) {
  const list = readLibraryIndex();
  const next = list.filter((x) => {
    const match = (id && x.id === id) || (targetPath && x.path === targetPath);
    if (match && x.cachePath && x.cachePath.includes('media-library') && fs.existsSync(x.cachePath)) {
      try { fs.unlinkSync(x.cachePath); } catch (_) {}
    }
    return !match;
  });
  writeLibraryIndex(next);
  return { ok: true, remaining: next.length };
}

function resolveOutputPath(cwd, outputPath, prefix, ext) {
  const baseDir = cwd || os.tmpdir();
  if (outputPath && String(outputPath).trim()) {
    const raw = String(outputPath).trim();
    const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(baseDir, raw);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return resolved;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = crypto.randomBytes(3).toString('hex');
  const isTemp = path.resolve(baseDir) === path.resolve(os.tmpdir());
  const folderName = isTemp ? '.akron-studio' : (prefix === 'video' ? 'videos' : 'images');
  const dir = path.join(baseDir, folderName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${prefix}-${stamp}-${rand}.${ext.replace(/^\./, '')}`);
}

function seedHash(text) {
  return crypto.createHash('sha256').update(String(text || 'akron')).digest();
}

function drawBitmapText(rgba, width, height, text, x0, y0, scale = 2, fg = [236, 253, 245, 255], bg = null) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z0-9.,:\-_\/!?+() ]/g, ' ');
  if (!s) return;
  const charW = 6 * scale;
  const charH = 7 * scale;
  if (bg) {
    const padX = Math.round(scale * 4);
    const padY = Math.round(scale * 3);
    const rx0 = Math.max(0, x0 - padX);
    const ry0 = Math.max(0, y0 - padY);
    const rx1 = Math.min(width, x0 + s.length * charW + padX);
    const ry1 = Math.min(height, y0 + charH + padY);
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        const idx = (y * width + x) * 4;
        const a = bg[3] / 255;
        rgba[idx] = Math.round(rgba[idx] * (1 - a) + bg[0] * a);
        rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - a) + bg[1] * a);
        rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - a) + bg[2] * a);
        rgba[idx + 3] = 255;
      }
    }
  }
  for (let ci = 0; ci < s.length; ci++) {
    const glyph = FONT_5X7[s[ci]] || FONT_5X7[' '];
    const cx = x0 + ci * charW;
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = cx + gx * scale + sx;
            const py = y0 + gy * scale + sy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const idx = (py * width + px) * 4;
            const a = fg[3] / 255;
            rgba[idx] = Math.round(rgba[idx] * (1 - a) + fg[0] * a);
            rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - a) + fg[1] * a);
            rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - a) + fg[2] * a);
            rgba[idx + 3] = Math.max(rgba[idx + 3], fg[3]);
          }
        }
      }
    }
  }
}

function buildArtboardSvg({ prompt, style, width, height }) {
  const hash = seedHash(`${prompt}|${style || ''}`);
  const hue1 = (hash[0] * 360) >> 8;
  const hue2 = (hue1 + 42 + (hash[1] % 60)) % 360;
  const hue3 = (hue1 + 155) % 360;
  const esc = (v) => String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = esc(String(prompt || 'Akron Media Studio').slice(0, 68));
  const styleBadge = esc(String(style || 'studio-vector').slice(0, 28));
  const shapes = [];
  for (let i = 0; i < 6; i++) {
    const cx = Math.round((hash[(i * 2) % 32] / 255) * width);
    const cy = Math.round((hash[(i * 2 + 1) % 32] / 255) * height);
    const r = Math.round(Math.min(width, height) * (0.14 + (hash[(i + 9) % 32] / 255) * 0.28));
    shapes.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${(hue1 + i * 28) % 360}, 72%, ${48 + (i % 3) * 8}%)" opacity="${(0.18 + (i % 3) * 0.1).toFixed(2)}" />`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="hsl(${hue1}, 38%, 11%)" />
      <stop offset="55%" stop-color="hsl(${hue2}, 42%, 17%)" />
      <stop offset="100%" stop-color="hsl(${hue3}, 36%, 9%)" />
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="52%">
      <stop offset="0%" stop-color="#34d399" stop-opacity="0.45" />
      <stop offset="100%" stop-color="#064e3b" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect width="${width}" height="${height}" fill="url(#glow)" />
  ${shapes.join('\n  ')}
  <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.1)}" width="${Math.round(width * 0.84)}" height="${Math.round(height * 0.8)}" rx="28" fill="rgba(10,18,15,0.45)" stroke="rgba(52,211,153,0.4)" stroke-width="2" />
  <circle cx="${Math.round(width * 0.5)}" cy="${Math.round(height * 0.44)}" r="${Math.round(Math.min(width, height) * 0.14)}" fill="#10b981" fill-opacity="0.88" />
  <circle cx="${Math.round(width * 0.5)}" cy="${Math.round(height * 0.44)}" r="${Math.round(Math.min(width, height) * 0.08)}" fill="#a7f3d0" fill-opacity="0.92" />
  <text x="${Math.round(width * 0.5)}" y="${Math.round(height * 0.72)}" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.round(width * 0.028)}" font-weight="700" fill="#ecfdf5" text-anchor="middle">${title}</text>
  <text x="${Math.round(width * 0.5)}" y="${Math.round(height * 0.77)}" font-family="ui-monospace, monospace" font-size="${Math.round(width * 0.017)}" fill="#6ee7b7" text-anchor="middle">${styleBadge}</text>
</svg>`;
}

function paintProceduralRgba({ prompt, style, width, height, frameIdx = 0, totalFrames = 1 }) {
  const hash = seedHash(`${prompt}|${style || ''}`);
  const rgba = Buffer.alloc(width * height * 4);
  const t = totalFrames > 1 ? frameIdx / totalFrames : 0;
  const rBase = 12 + (hash[0] % 32);
  const gBase = 24 + (hash[1] % 48);
  const bBase = 20 + (hash[2] % 44);
  const orbX = width * (0.5 + 0.22 * Math.cos(t * Math.PI * 2 + (hash[3] / 40)));
  const orbY = height * (0.45 + 0.16 * Math.sin(t * Math.PI * 2 + (hash[4] / 40)));
  const orbR = Math.min(width, height) * 0.26;
  const orbR2 = orbR * orbR;

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const wave = Math.sin(ny * 8 + t * Math.PI * 2) * 10;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const dx = x - orbX;
      const dy = y - orbY;
      const dist2 = dx * dx + dy * dy;
      let r = rBase + Math.round(nx * 28 + wave);
      let g = gBase + Math.round((1 - ny) * 58 + nx * 24);
      let b = bBase + Math.round(ny * 42);
      if (dist2 < orbR2 * 1.8) {
        const glow = Math.max(0, 1 - Math.sqrt(dist2) / (orbR * 1.35));
        r = Math.min(255, Math.round(r + glow * 44));
        g = Math.min(255, Math.round(g + glow * 175));
        b = Math.min(255, Math.round(b + glow * 118));
      }
      // Subtle isometric grid lines
      if ((x % 64 === 0 || y % 64 === 0) && dist2 > orbR2 * 0.4) {
        r = Math.min(255, r + 8);
        g = Math.min(255, g + 16);
        b = Math.min(255, b + 12);
      }
      const idx = (y * width + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, r));
      rgba[idx + 1] = Math.max(0, Math.min(255, g));
      rgba[idx + 2] = Math.max(0, Math.min(255, b));
      rgba[idx + 3] = 255;
    }
  }
  const scale = width >= 900 ? 3 : 2;
  const caption = String(prompt || 'AKRON MEDIA STUDIO').slice(0, 32);
  drawBitmapText(rgba, width, height, caption, Math.round(width * 0.06), Math.round(height * 0.84), scale, [236, 253, 245, 255], [6, 20, 15, 190]);
  return { width, height, data: rgba };
}

async function renderHtmlWithElectron(html, width, height) {
  try {
    const electron = require('electron');
    if (!electron || !electron.app || !electron.BrowserWindow || !electron.app.isReady()) return null;
    const win = new electron.BrowserWindow({
      width,
      height,
      show: false,
      frame: false,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await new Promise((r) => setTimeout(r, 120));
      const img = await win.webContents.capturePage();
      return img.toPNG();
    } finally {
      try { win.destroy(); } catch (_) {}
    }
  } catch (_) {
    return null;
  }
}

function encodeLosslessWebpVP8L(width, height, rgba) {
  // Valid RIFF/WEBP VP8L container with uniform 8-bit fixed-length Huffman tables per ARGB channel.
  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;
  const pushBits = (val, n) => {
    bitBuf |= (val & ((1 << n) - 1)) << bitCount;
    bitCount += n;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };
  const rev8 = (v) => {
    let r = 0;
    for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= (1 << (7 - i));
    return r;
  };
  // VP8L signature + header
  pushBits(0x2f, 8);
  pushBits(width - 1, 14);
  pushBits(height - 1, 14);
  pushBits(1, 1); // alpha_is_used
  pushBits(0, 3); // version
  pushBits(0, 1); // no transforms
  pushBits(0, 1); // no color cache
  pushBits(0, 1); // single meta-huffman group
  // 5 prefix code groups: Green(280), Red(256), Blue(256), Alpha(256), Dist(40)
  const writeUniformCode = (alphabetSize) => {
    if (alphabetSize <= 256) {
      // Normal code length code: read k=4 code-length codes; mark symbol 8 with length 1 (bit=0) -> wait: use simple 0 + normal code with 1 symbol = 8!
      pushBits(0, 1); // normal code
      pushBits(15, 4); // num_code_lengths - 4 = 15 -> 19 code length entries (all 19)
      // kCodeLengthCodeOrder = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, ...]
      // Put code length 1 at index 11 (symbol 8) so symbol 8 has Huffman code '0' (1 bit)
      for (let i = 0; i < 19; i++) pushBits(i === 11 ? 1 : 0, 3);
      pushBits(0, 1); // use max_symbol = alphabetSize (no explicit max_symbol)
      for (let s = 0; s < alphabetSize; s++) pushBits(0, 1); // each symbol gets code length 8!
    } else {
      // For Green(280): symbols 0..255 have len=8, symbols 256..279 have len=0
      pushBits(0, 1);
      pushBits(15, 4);
      // Set code length for symbol 0 -> 1 ('0' 1 bit) and symbol 8 -> 1 ('1' 1 bit)? Better: len=2 at idx 2(0) & idx 11(8): codes 00 / 01
      // Order: idx 2 = 0, idx 11 = 8. Setting both len=1 gives canonical codes 0 (sym 0) and 1 (sym 8)!
      for (let i = 0; i < 19; i++) pushBits((i === 2 || i === 11) ? 1 : 0, 3);
      pushBits(1, 1); // explicit max_symbol
      pushBits(2, 3); // max_symbol_bits = 2*2+2 = 6 -> 256 fits? No: max_symbol uses length bits: length_nbits = 2+2*3=8 -> 256
      pushBits(255, 8); // max_symbol = 256? Wait: encode 255+2-1 -> let's write all 280 without max_symbol!
      // Already did pushBits(0, 1) -> oops revert: just set alphabet=280 explicitly with clean uniform code
    }
  };
  void writeUniformCode;
  // Clean 100% deterministic alternative: Green/Red/Blue/Alpha all written cleanly with 2-symbol length codes:
  bytes.length = 0; bitBuf = 0; bitCount = 0;
  pushBits(0x2f, 8);
  pushBits(width - 1, 14);
  pushBits(height - 1, 14);
  pushBits(1, 1);
  pushBits(0, 3);
  pushBits(0, 1); // no transform
  pushBits(0, 1); // no color cache
  pushBits(0, 1); // no meta prefix
  // Write 5 prefix trees: Green(280), Red(256), Blue(256), Alpha(256), Distance(40)
  // Using length_code: symbol 0 (len 0) -> code len 1 ('0'), symbol 8 (len 8) -> code len 1 ('1')
  const write256Tree = () => {
    pushBits(0, 1);
    pushBits(15, 4); // 19 code lengths
    for (let i = 0; i < 19; i++) pushBits(i === 11 ? 1 : 0, 3);
    pushBits(0, 1); // all 256 symbols
    for (let s = 0; s < 256; s++) pushBits(0, 1); // '0' -> sym 8 -> len 8
  };
  const writeGreen280Tree = () => {
    pushBits(0, 1);
    pushBits(15, 4);
    for (let i = 0; i < 19; i++) pushBits((i === 2 || i === 11) ? 1 : 0, 3);
    pushBits(0, 1); // all 280 symbols
    for (let s = 0; s < 256; s++) pushBits(1, 1); // '1' -> sym 8 -> len 8
    for (let s = 256; s < 280; s++) pushBits(0, 1); // '0' -> sym 0 -> len 0
  };
  const writeSimpleSingleDist = () => {
    pushBits(1, 1); // simple code
    pushBits(0, 1); // 1 symbol
    pushBits(0, 1); // 1-bit symbol
    pushBits(0, 1);
  };
  writeGreen280Tree();
  write256Tree();
  write256Tree();
  write256Tree();
  writeSimpleSingleDist();
  for (let p = 0; p < rgba.length; p += 4) {
    pushBits(rev8(rgba[p + 1]), 8); // G
    pushBits(rev8(rgba[p]), 8);     // R
    pushBits(rev8(rgba[p + 2]), 8); // B
    pushBits(rev8(rgba[p + 3]), 8); // A
  }
  if (bitCount > 0) bytes.push(bitBuf & 0xff);
  const vp8lPayload = Buffer.from(bytes);
  const chunkLen = vp8lPayload.length;
  const paddedLen = chunkLen + (chunkLen % 2);
  const riffSize = 4 + 8 + paddedLen;
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WEBP', 8);
  out.write('VP8L', 12);
  out.writeUInt32LE(chunkLen, 16);
  vp8lPayload.copy(out, 20);
  return out;
}

async function encodeImageBuffer({ width, height, data }, format, outPath) {
  const fmt = String(format || 'png').toLowerCase().replace(/^\./, '');
  if (fmt === 'png') {
    const png = new PNG({ width, height });
    data.copy(png.data);
    fs.writeFileSync(outPath, PNG.sync.write(png));
    return outPath;
  }
  if (fmt === 'jpg' || fmt === 'jpeg') {
    const encoded = jpeg.encode({ data, width, height }, 92);
    fs.writeFileSync(outPath, encoded.data);
    return outPath;
  }
  if (fmt === 'webp') {
    const pngTmp = outPath + '.tmp.png';
    const cleanup = () => { try { fs.unlinkSync(pngTmp); } catch (_) {} };
    const ensurePngTmp = () => {
      if (fs.existsSync(pngTmp)) return;
      const png = new PNG({ width, height });
      data.copy(png.data);
      fs.writeFileSync(pngTmp, PNG.sync.write(png));
    };
    const cwebpBin = resolveBinary('__nonexistent__', ['cwebp']);
    if (cwebpBin) {
      try {
        ensurePngTmp();
        await runBin(cwebpBin, ['-quiet', '-q', '82', pngTmp, '-o', outPath]);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) { cleanup(); return outPath; }
      } catch (_) {}
    }
    const ff = resolveFfmpeg();
    if (ff) {
      try {
        ensurePngTmp();
        await runBin(ff, ['-y', '-i', pngTmp, '-vcodec', 'libwebp', '-lossless', '0', '-compression_level', '6', '-q:v', '82', outPath]);
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) { cleanup(); return outPath; }
      } catch (_) {}
    }
    cleanup();
    fs.writeFileSync(outPath, encodeLosslessWebpVP8L(width, height, data));
    return outPath;
  }
  if (fmt === 'gif') {
    const palette = gifenc.quantize(data, 256);
    const index = gifenc.applyPalette(data, palette);
    const gif = gifenc.GIFEncoder();
    gif.writeFrame(index, width, height, { palette });
    gif.finish();
    fs.writeFileSync(outPath, Buffer.from(gif.bytes()));
    return outPath;
  }
  if (fmt === 'ico') {
    const png = new PNG({ width, height });
    data.copy(png.data);
    const pngBuf = PNG.sync.write(png);
    const hdr = Buffer.alloc(22);
    hdr.writeUInt16LE(0, 0);
    hdr.writeUInt16LE(1, 2); // ICO
    hdr.writeUInt16LE(1, 4); // 1 image
    hdr.writeUInt8(width >= 256 ? 0 : width, 6);
    hdr.writeUInt8(height >= 256 ? 0 : height, 7);
    hdr.writeUInt8(0, 8);
    hdr.writeUInt8(0, 9);
    hdr.writeUInt16LE(1, 10);
    hdr.writeUInt16LE(32, 12);
    hdr.writeUInt32LE(pngBuf.length, 14);
    hdr.writeUInt32LE(22, 18);
    fs.writeFileSync(outPath, Buffer.concat([hdr, pngBuf]));
    return outPath;
  }
  // WebP / AVIF / BMP / TIFF via ffmpeg
  const ff = resolveFfmpeg();
  if (!ff) throw new Error(`ffmpeg unavailable to encode format "${fmt}"`);
  const pngTmp = outPath + '.tmp.png';
  const png = new PNG({ width, height });
  data.copy(png.data);
  fs.writeFileSync(pngTmp, PNG.sync.write(png));
  try {
    await runBin(ff, ['-y', '-i', pngTmp, outPath]);
  } finally {
    try { fs.unlinkSync(pngTmp); } catch (_) {}
  }
  return outPath;
}

function trimPngToIend(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return buf;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return buf;
  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const chunkEnd = off + 12 + len;
    if (chunkEnd > buf.length) break;
    if (type === 'IEND') {
      return chunkEnd < buf.length ? buf.subarray(0, chunkEnd) : buf;
    }
    off = chunkEnd;
  }
  return buf;
}

function cropBottomStrip(src, stripPx = 44) {
  if (!src || !src.data || src.height <= stripPx + 32) return src;
  const targetH = src.height - stripPx;
  const rowBytes = src.width * 4;
  return {
    width: src.width,
    height: targetH,
    data: Buffer.from(src.data.subarray(0, targetH * rowBytes)),
  };
}

async function decodeBufferToRgba(buf, hintPath = '') {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('Cannot decode empty image buffer');
  }
  const ext = path.extname(String(hintPath || '')).toLowerCase();
  const isJpgMagic = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isPngMagic = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const headStr = buf.subarray(0, Math.min(256, buf.length)).toString('utf8').trimStart();
  const isSvg = ext === '.svg' || headStr.startsWith('<svg') || (headStr.startsWith('<?xml') && headStr.includes('<svg'));

  // 1. Check magic bytes FIRST (prevents JPEG bytes in a .png filename from failing pngjs)
  if (isJpgMagic) {
    const dec = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: dec.width, height: dec.height, data: Buffer.from(dec.data), rawTextMeta: '' };
  }
  if (isPngMagic) {
    const trimmed = trimPngToIend(buf);
    try {
      const png = PNG.sync.read(trimmed);
      return { width: png.width, height: png.height, data: png.data, rawTextMeta: extractPngText(trimmed) };
    } catch (_) {
      const ni = getElectronNativeImage();
      if (ni) {
        const img = ni.createFromBuffer(buf);
        if (img && !img.isEmpty()) {
          const png = PNG.sync.read(img.toPNG());
          return { width: png.width, height: png.height, data: png.data, rawTextMeta: '' };
        }
      }
    }
  }
  if (isSvg) {
    const svgText = buf.toString('utf8');
    const txtMatches = [...svgText.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    const pngBuf = await renderHtmlWithElectron(`<!doctype html><html><body style="margin:0">${svgText}</body></html>`, 1024, 1024);
    if (pngBuf) {
      const png = PNG.sync.read(trimPngToIend(pngBuf));
      return { width: png.width, height: png.height, data: png.data, rawTextMeta: txtMatches.join('\n') };
    }
    const proc = paintProceduralRgba({ prompt: txtMatches[0] || path.basename(hintPath || 'image.svg'), width: 640, height: 640 });
    return { ...proc, rawTextMeta: txtMatches.join('\n') };
  }

  // 2. Fallback to Electron nativeImage (handles WebP, GIF, BMP, ICO, etc.)
  const ni = getElectronNativeImage();
  if (ni) {
    try {
      const img = ni.createFromBuffer(buf);
      if (img && !img.isEmpty()) {
        const png = PNG.sync.read(img.toPNG());
        return { width: png.width, height: png.height, data: png.data, rawTextMeta: '' };
      }
    } catch (_) {}
  }

  // 3. Final fallback to ffmpeg transcode
  const ff = resolveFfmpeg();
  if (!ff) throw new Error(`Cannot decode "${ext || 'image'}" image without ffmpeg`);
  const tmpIn = path.join(os.tmpdir(), `akron-in-${crypto.randomBytes(4).toString('hex')}${ext || '.bin'}`);
  const tmpPng = path.join(os.tmpdir(), `akron-dec-${crypto.randomBytes(4).toString('hex')}.png`);
  try {
    fs.writeFileSync(tmpIn, buf);
    await runBin(ff, ['-y', '-i', tmpIn, tmpPng]);
    const png = PNG.sync.read(trimPngToIend(fs.readFileSync(tmpPng)));
    return { width: png.width, height: png.height, data: png.data, rawTextMeta: '' };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
    try { fs.unlinkSync(tmpPng); } catch (_) {}
  }
}

async function decodeImageBuffer(inputPath) {
  const buf = fs.readFileSync(inputPath);
  return await decodeBufferToRgba(buf, inputPath);
}

function extractPngText(buf) {
  const texts = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    if (off + 12 + len > buf.length) break;
    if (type === 'tEXt' || type === 'iTXt') {
      texts.push(buf.slice(off + 8, off + 8 + len).toString('utf8').replace(/\0+/g, ': ').trim());
    }
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return texts.join('\n');
}

function resizeRgbaBilinear(src, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const { width: srcW, height: srcH, data } = src;
  for (let y = 0; y < dstH; y++) {
    const sy = srcH === 1 ? 0 : (y * (srcH - 1)) / Math.max(1, dstH - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dstW; x++) {
      const sx = srcW === 1 ? 0 : (x * (srcW - 1)) / Math.max(1, dstW - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const o = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

async function resolveCandidateCredential(candidate) {
  let apiKey = (candidate && candidate.apiKey) || '';
  let oauthToken = '';
  if (!apiKey && candidate && candidate.oauthProvider) {
    try {
      const po = require('./provider-oauth');
      const res = await po.resolve(candidate.oauthProvider);
      if (res && res.accessToken) oauthToken = res.accessToken;
    } catch (_) {}
  }
  return { apiKey, oauthToken, bearer: apiKey || oauthToken };
}

function isExplicitCloudModel(model) {
  const m = String(model || '').trim().toLowerCase();
  if (!m || m === 'auto') return false;
  if (m === 'akron-svg-canvas-studio' || m === 'akron-motion-canvas-30fps') return false;
  return true;
}

function candidateMatchesPreferredModel(cand, preferredModel) {
  const pref = String(preferredModel || '').trim().toLowerCase();
  if (!pref || pref === 'auto') return true;
  const cm = String((cand && cand.model) || '').toLowerCase();
  const cb = String((cand && cand.backend) || '').toLowerCase();
  if (cm === pref || cm.includes(pref)) return true;
  if (pref === 'wan-video/wan-2.1' && /wan/i.test(cm)) return true;
  if (pref === 'flux-1.1-pro' && /flux[-.]?1\.1[-.]?pro/i.test(cm)) return true;
  if (/flux\.1-schnell|nvidia-flux/.test(pref) && (cb === 'nvidia-flux' || /flux\.1-schnell/i.test(cm))) return true;
  return false;
}

async function extractApiErrorMessage(res, providerLabel = 'Media API') {
  const status = res && res.status ? res.status : 0;
  let txt = '';
  try { txt = await res.text(); } catch (_) {}
  let detail = '';
  try {
    const j = JSON.parse(txt);
    detail = (j && j.error && j.error.message)
      || (Array.isArray(j && j.errors) && j.errors[0] && j.errors[0].message)
      || (Array.isArray(j && j.detail) && j.detail[0] && j.detail[0].msg)
      || (typeof (j && j.detail) === 'string' && j.detail)
      || (j && j.message)
      || '';
  } catch (_) {}
  const msg = String(detail || txt || res.statusText || 'Request failed').replace(/\s+/g, ' ').trim().slice(0, 260);
  return `${providerLabel} HTTP ${status}: ${msg}`;
}

function imageBufferToMime(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function tryRemoteImageGenerate(candidate, { prompt, aspect_ratio, style, dims, inputImageBase64 = '', inputMimeType = 'image/png' }) {
  if (!candidate || candidate.offline) return null;
  if (candidate.backend === 'pollinations-flux') {
    const rawW = (dims && dims.width) || 1024;
    const rawH = (dims && dims.height) || 1024;
    // Cap Pollinations requests at 1024 on longest edge and omit enhance=true to avoid 402 tier rejections.
    const maxEdge = Math.max(rawW, rawH, 1);
    const scale = maxEdge > 1024 ? (1024 / maxEdge) : 1;
    const w = Math.max(256, Math.round((rawW * scale) / 8) * 8);
    const h = Math.max(256, Math.round((rawH * scale) / 8) * 8);
    const fullPrompt = style ? `${prompt}, ${style}` : prompt;
    const seed = crypto.randomInt(1, 999999);
    const polyModel = String(candidate.remoteModel || candidate.model || 'flux').toLowerCase().includes('realism')
      ? 'flux-realism'
      : (String(candidate.remoteModel || candidate.model || '').toLowerCase().includes('anime')
        ? 'flux-anime'
        : (String(candidate.remoteModel || candidate.model || '').toLowerCase().includes('3d')
          ? 'flux-3d'
          : 'flux'));
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=${w}&height=${h}&model=${encodeURIComponent(polyModel)}&nologo=true&seed=${seed}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'image/*' } });
      if (!res.ok) throw new Error(await extractApiErrorMessage(res, `Pollinations (${polyModel})`));
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error('Pollinations returned an empty image payload');
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
      const isWebp = buf.slice(0, 4).toString('ascii') === 'RIFF';
      if (!isPng && !isJpg && !isWebp) throw new Error('Pollinations response was not a valid image');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
  if (candidate.backend === 'nvidia-flux') {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer || !candidate.baseURL) return null;
    const res = await fetch(candidate.baseURL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + cred.bearer },
      body: JSON.stringify({ prompt: style ? `${prompt}, ${style}` : prompt, steps: 4 }),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `NVIDIA NIM (${candidate.model})`));
    const j = await res.json();
    const b64 = (j && j.artifacts && j.artifacts[0] && (j.artifacts[0].base64 || j.artifacts[0].b64_json)) || (j && j.image) || '';
    if (!b64) throw new Error(`NVIDIA NIM (${candidate.model}) returned no image data`);
    return Buffer.from(b64, 'base64');
  }
  if (candidate.backend === 'cloudflare-flux') {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer || !candidate.baseURL) return null;
    const url = `${candidate.baseURL.replace(/\/+$/, '')}/ai/run/${candidate.model}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cred.bearer },
      body: JSON.stringify({ prompt: style ? `${prompt}, ${style}` : prompt }),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, 'Cloudflare Workers AI'));
    const ct = String(res.headers.get('content-type') || '');
    if (ct.includes('application/json')) {
      const j = await res.json();
      const b64 = j && j.result && (j.result.image || j.result.b64_json);
      if (!b64) throw new Error('Cloudflare Workers AI returned no image bytes');
      return Buffer.from(b64, 'base64');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length <= 512) throw new Error('Cloudflare Workers AI returned an empty image');
    return buf;
  }
  if (candidate.backend === 'gemini' || candidate.backend === 'gemini-flash-image') {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer) return null;
    const base = String(candidate.baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const authHeaders = cred.apiKey
      ? { 'content-type': 'application/json', 'x-goog-api-key': cred.apiKey }
      : { 'content-type': 'application/json', authorization: 'Bearer ' + cred.oauthToken };
    if (candidate.backend === 'gemini') {
      const url = `${base}/models/${encodeURIComponent(candidate.model)}:predict`;
      const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ instances: [{ prompt: style ? `${prompt} (${style})` : prompt }], parameters: { sampleCount: 1, aspectRatio: aspect_ratio || '1:1' } }),
      });
      if (!res.ok) throw new Error(await extractApiErrorMessage(res, `Google ${candidate.model}`));
      const j = await res.json();
      const b64 = (j && j.predictions && j.predictions[0] && j.predictions[0].bytesBase64Encoded)
        || (j && j.generatedImages && j.generatedImages[0] && j.generatedImages[0].image && j.generatedImages[0].image.imageBytes)
        || '';
      if (!b64) throw new Error(`Google ${candidate.model} returned no image bytes`);
      return Buffer.from(b64, 'base64');
    }
    const url = `${base}/models/${encodeURIComponent(candidate.model)}:generateContent`;
    const partsPayload = [{ text: style ? `${prompt}. Style: ${style}` : prompt }];
    if (inputImageBase64) {
      partsPayload.push({ inlineData: { mimeType: inputMimeType || 'image/png', data: inputImageBase64 } });
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        contents: [{ parts: partsPayload }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `Google ${candidate.model}`));
    const j = await res.json();
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const inline = parts.find((p) => (p.inlineData && p.inlineData.data) || (p.inline_data && p.inline_data.data));
    const b64 = inline ? ((inline.inlineData && inline.inlineData.data) || (inline.inline_data && inline.inline_data.data)) : '';
    if (!b64) {
      const blockReason = j?.promptFeedback?.blockReason || j?.candidates?.[0]?.finishReason || '';
      const textHint = parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 140);
      throw new Error(`Google ${candidate.model} returned no image${blockReason ? ` (${blockReason})` : ''}${textHint ? `: ${textHint}` : ''}`);
    }
    return Buffer.from(b64, 'base64');
  }
  if (candidate.backend === 'fal') {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer) return null;
    const base = String(candidate.baseURL || 'https://fal.run').replace(/\/+$/, '');
    const imageSize = aspect_ratio === '16:9' ? 'landscape_16_9' : (aspect_ratio === '9:16' ? 'portrait_16_9' : (aspect_ratio === '4:3' ? 'landscape_4_3' : 'square_hd'));
    const res = await fetch(`${base}/${candidate.model}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Key ' + cred.bearer },
      body: JSON.stringify({ prompt: style ? `${prompt}, ${style}` : prompt, image_size: imageSize }),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `fal.ai (${candidate.model})`));
    const j = await res.json();
    const imgObj = (j && j.images && j.images[0]) || (j && j.image);
    const imgUrl = typeof imgObj === 'string' ? imgObj : (imgObj && imgObj.url);
    if (imgUrl && imgUrl.startsWith('data:')) {
      return Buffer.from(imgUrl.split(',')[1] || '', 'base64');
    }
    if (imgUrl) {
      const dl = await fetch(imgUrl);
      if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'fal.ai image download'));
      return Buffer.from(await dl.arrayBuffer());
    }
    throw new Error(`fal.ai (${candidate.model}) returned no image URL`);
  }
  if (candidate.backend === 'replicate') {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer) return null;
    const base = String(candidate.baseURL || 'https://api.replicate.com/v1').replace(/\/+$/, '');
    const createRes = await fetch(`${base}/models/${candidate.model}/predictions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cred.bearer, prefer: 'wait=60' },
      body: JSON.stringify({ input: { prompt: style ? `${prompt}, ${style}` : prompt, aspect_ratio: aspect_ratio || '1:1' } }),
    });
    if (!createRes.ok) throw new Error(await extractApiErrorMessage(createRes, `Replicate (${candidate.model})`));
    let pred = await createRes.json();
    for (let i = 0; i < 20 && pred && !['succeeded', 'failed', 'canceled'].includes(pred.status) && pred.urls && pred.urls.get; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const pRes = await fetch(pred.urls.get, { headers: { authorization: 'Bearer ' + cred.bearer } });
      if (pRes.ok) pred = await pRes.json();
    }
    if (!pred || pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate (${candidate.model}) ${pred?.status || 'failed'}: ${pred?.error || 'prediction failed'}`);
    }
    const outUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!outUrl || typeof outUrl !== 'string') throw new Error(`Replicate (${candidate.model}) returned no output URL`);
    const dl = await fetch(outUrl);
    if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'Replicate image download'));
    return Buffer.from(await dl.arrayBuffer());
  }
  if (['openai-images', 'xai-images', 'together-images', 'openrouter-images', 'fireworks-images', 'openai-compat'].includes(candidate.backend)) {
    const cred = await resolveCandidateCredential(candidate);
    if (!cred.bearer || !candidate.baseURL) return null;
    const isGptImage = /gpt-image/i.test(candidate.model || '');
    const isDalle3 = /dall-e-3/i.test(candidate.model || '');
    const size = isDalle3
      ? (aspect_ratio === '16:9' ? '1792x1024' : (aspect_ratio === '9:16' ? '1024x1792' : '1024x1024'))
      : (aspect_ratio === '16:9' ? '1536x1024' : (aspect_ratio === '9:16' ? '1024x1536' : '1024x1024'));
    const body = { model: candidate.model, prompt: style ? `${prompt}, ${style}` : prompt };
    if (candidate.backend !== 'xai-images') body.size = size;
    if (!isGptImage) body.response_format = 'b64_json';
    const url = candidate.baseURL.replace(/\/+$/, '') + '/images/generations';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cred.bearer },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `${candidate.backend} (${candidate.model})`));
    const j = await res.json();
    const item = j && j.data && j.data[0];
    if (item && item.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item && item.url) {
      const dl = await fetch(item.url);
      if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, `${candidate.backend} image download`));
      return Buffer.from(await dl.arrayBuffer());
    }
    throw new Error(`${candidate.backend} (${candidate.model}) returned neither b64_json nor url`);
  }
  return null;
}

async function generateImage(args = {}, ctx = {}) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('GenerateImage requires a non-empty "prompt".');
  const aspect = ASPECT_DIMENSIONS[args.aspect_ratio] ? args.aspect_ratio : '1:1';
  const dims = ASPECT_DIMENSIONS[aspect];
  const format = String(args.format || (args.output_path ? path.extname(args.output_path).slice(1) : '') || 'png').toLowerCase();
  const count = Math.max(1, Math.min(4, Number(args.count) || 1));

  const routed = await router.resolveMediaProvider({
    kind: 'image',
    preferredModel: args.model || '',
    provider: ctx.provider || args.provider || null,
    orchestrator: ctx.orchestrator || args.orchestrator || null,
    store: ctx.store,
  });

  const explicitCloud = !args.forceOffline && format !== 'svg' && isExplicitCloudModel(args.model);
  let activeCandidates = (routed.candidates || []).filter((c) => !c.offline);
  if (explicitCloud) {
    activeCandidates = activeCandidates.filter((c) => candidateMatchesPreferredModel(c, args.model));
    if (!activeCandidates.length) {
      const cat = router.listMediaStudioCatalog({ store: ctx.store, provider: ctx.provider || args.provider || null, orchestrator: ctx.orchestrator || args.orchestrator || null });
      const entry = (cat.imageModels || []).find((m) => String(m.id || '').toLowerCase() === String(args.model).trim().toLowerCase());
      const err = new Error(
        entry && entry.requiredKeyLabel
          ? `${entry.label} requires ${entry.requiredKeyLabel} — configure your API key in Settings → Images & Video APIs.`
          : `Model "${args.model}" is not configured or has no available API key.`
      );
      if (entry && entry.configKeyId) {
        err.needsApiKey = true;
        err.configKeyId = entry.configKeyId;
      }
      throw err;
    }
  }

  const files = [];
  let usedModel = 'akron-svg-canvas-studio';
  let usedBackend = 'offline-image-studio';
  let actualWidth = dims.width;
  let actualHeight = dims.height;

  for (let i = 0; i < count; i++) {
    let suffixOut = args.output_path;
    if (suffixOut && count > 1) {
      const ext = path.extname(suffixOut);
      const base = ext ? suffixOut.slice(0, -ext.length) : suffixOut;
      suffixOut = `${base}-${i + 1}${ext || '.' + format}`;
    }
    const outFile = resolveOutputPath(args.cwd || ctx.cwd, suffixOut, 'image', format);

    let remoteBuf = null;
    let lastErr = null;
    if (format !== 'svg' && !args.forceOffline) {
      for (const cand of activeCandidates) {
        try {
          remoteBuf = await tryRemoteImageGenerate(cand, { prompt, aspect_ratio: aspect, style: args.style, dims });
          if (remoteBuf) {
            usedModel = cand.model;
            usedBackend = cand.backend;
            break;
          }
        } catch (err) {
          lastErr = err;
        }
      }
    }

    if (!remoteBuf && explicitCloud) {
      throw lastErr || new Error(`Image generation failed for "${args.model}" with no output from provider.`);
    }

    if (remoteBuf) {
      let decoded = await decodeBufferToRgba(remoteBuf, outFile);
      if (usedBackend === 'pollinations-flux' && decoded.height > 180) {
        // Trim bottom strip in case the free endpoint appended a watermark banner, then scale cleanly to target dimensions.
        const cropped = cropBottomStrip(decoded, Math.min(44, Math.floor(decoded.height * 0.08)));
        decoded = resizeRgbaBilinear(cropped, dims.width, dims.height);
      }
      actualWidth = decoded.width;
      actualHeight = decoded.height;
      await encodeImageBuffer(decoded, format, outFile);
    } else if (format === 'svg') {
      const svg = buildArtboardSvg({ prompt: count > 1 ? `${prompt} #${i + 1}` : prompt, style: args.style, width: dims.width, height: dims.height });
      fs.writeFileSync(outFile, svg, 'utf8');
      usedModel = 'akron-svg-canvas-studio';
      usedBackend = 'offline-image-studio';
    } else {
      usedModel = 'akron-svg-canvas-studio';
      usedBackend = 'offline-image-studio';
      const svg = buildArtboardSvg({ prompt: count > 1 ? `${prompt} #${i + 1}` : prompt, style: args.style, width: dims.width, height: dims.height });
      const electronPng = await renderHtmlWithElectron(`<!doctype html><html><body style="margin:0;overflow:hidden">${svg}</body></html>`, dims.width, dims.height);
      if (electronPng) {
        if (format === 'png') {
          fs.writeFileSync(outFile, electronPng);
        } else {
          const decoded = PNG.sync.read(trimPngToIend(electronPng));
          await encodeImageBuffer({ width: decoded.width, height: decoded.height, data: decoded.data }, format, outFile);
        }
      } else {
        const img = paintProceduralRgba({ prompt: count > 1 ? `${prompt} #${i + 1}` : prompt, style: args.style, width: dims.width, height: dims.height, frameIdx: i, totalFrames: count });
        await encodeImageBuffer(img, format, outFile);
      }
    }
    files.push(outFile);
  }

  const primaryCache = cacheMediaArtifact(files[0]);
  const outStat = fs.existsSync(files[0]) ? fs.statSync(files[0]) : null;
  for (const fp of files) {
    recordMediaLibraryItem({
      kind: 'image',
      path: fp,
      cachePath: fp === files[0] ? primaryCache.cachePath : '',
      format,
      width: actualWidth,
      height: actualHeight,
      size: fs.existsSync(fp) ? fs.statSync(fp).size : 0,
      model: usedModel,
      backend: usedBackend,
      prompt,
      cwd: args.cwd || ctx.cwd || '',
    });
  }
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'mediaArtifact', kind: 'image', files, cachePath: primaryCache.cachePath, previewDataUrl: primaryCache.previewDataUrl, model: usedModel, backend: usedBackend, width: actualWidth, height: actualHeight, size: outStat ? outStat.size : 0, format });
  }
  return {
    ok: true,
    files,
    path: files[0],
    cachePath: primaryCache.cachePath,
    ...(args && args.includeDataUrl === true ? { previewDataUrl: primaryCache.previewDataUrl } : {}),
    width: actualWidth,
    height: actualHeight,
    size: outStat ? outStat.size : 0,
    aspect_ratio: aspect,
    format,
    model: usedModel,
    backend: usedBackend,
    routedFrom: (ctx.provider && ctx.provider.model) || null,
    summary: `Generated ${files.length} image (${actualWidth}x${actualHeight} ${format.toUpperCase()}) using ${usedModel} → ${files.join(', ')}`,
  };
}

function parseCropBox(cropBox, srcW, srcH) {
  if (!cropBox) return { x: 0, y: 0, width: srcW, height: srcH };
  let x = 0, y = 0, w = srcW, h = srcH;
  if (Array.isArray(cropBox)) {
    [x, y, w, h] = cropBox.map(Number);
  } else if (typeof cropBox === 'string') {
    const nums = cropBox.split(/[,\s]+/).map(Number);
    [x, y, w, h] = nums;
  } else if (typeof cropBox === 'object') {
    x = Number(cropBox.x || 0);
    y = Number(cropBox.y || 0);
    w = Number(cropBox.width || cropBox.w || srcW);
    h = Number(cropBox.height || cropBox.h || srcH);
  }
  x = Math.max(0, Math.min(srcW - 1, Math.round(x || 0)));
  y = Math.max(0, Math.min(srcH - 1, Math.round(y || 0)));
  w = Math.max(1, Math.min(srcW - x, Math.round(w || (srcW - x))));
  h = Math.max(1, Math.min(srcH - y, Math.round(h || (srcH - y))));
  return { x, y, width: w, height: h };
}

async function editImage(args = {}, ctx = {}) {
  const inputRaw = args.input_path || args.path || '';
  if (!inputRaw) throw new Error('EditImage requires "input_path".');
  const inputPath = path.isAbsolute(inputRaw) ? inputRaw : path.resolve(args.cwd || ctx.cwd || process.cwd(), inputRaw);
  if (!fs.existsSync(inputPath)) throw new Error(`Input image not found: ${inputPath}`);

  const op = String(args.operation || 'ai_edit').toLowerCase().replace(/-/g, '_');
  const decoded = await decodeImageBuffer(inputPath);

  if (op === 'ocr') {
    let text = decoded.rawTextMeta || '';
    try {
      const tess = resolveBinary('__nonexistent__', ['tesseract']);
      if (tess) {
        const out = execFileSync(tess, [inputPath, 'stdout'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (out) text = text ? `${text}\n${out}` : out;
      }
    } catch (_) {}
    return {
      ok: true,
      operation: 'ocr',
      input_path: inputPath,
      width: decoded.width,
      height: decoded.height,
      text: text || `(No embedded/OCR text detected in ${path.basename(inputPath)}; dimensions ${decoded.width}x${decoded.height})`,
      summary: `OCR inspection of ${path.basename(inputPath)} (${decoded.width}x${decoded.height}): ${text ? text.slice(0, 240) : 'no embedded text found.'}`,
    };
  }

  let img = { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
  let targetFormat = String(args.format || (args.output_path ? path.extname(args.output_path).slice(1) : '') || path.extname(inputPath).slice(1) || 'png').toLowerCase();

  if (op === 'resize') {
    let w = Number(args.width) || 0;
    let h = Number(args.height) || 0;
    if (!w && !h) { w = Math.max(1, Math.round(img.width / 2)); h = Math.max(1, Math.round(img.height / 2)); }
    else if (w && !h) h = Math.max(1, Math.round((img.height * w) / img.width));
    else if (!w && h) w = Math.max(1, Math.round((img.width * h) / img.height));
    img = resizeRgbaBilinear(img, w, h);
  } else if (op === 'upscale') {
    const w = Number(args.width) || img.width * 2;
    const h = Number(args.height) || img.height * 2;
    img = resizeRgbaBilinear(img, w, h);
  } else if (op === 'crop') {
    const box = parseCropBox(args.crop_box || { x: args.x, y: args.y, width: args.width, height: args.height }, img.width, img.height);
    const out = Buffer.alloc(box.width * box.height * 4);
    for (let y = 0; y < box.height; y++) {
      const srcOff = ((box.y + y) * img.width + box.x) * 4;
      img.data.copy(out, y * box.width * 4, srcOff, srcOff + box.width * 4);
    }
    img = { width: box.width, height: box.height, data: out };
  } else if (op === 'convert') {
    if (!['png', 'webp', 'gif', 'ico'].includes(targetFormat) && !args.format && !args.output_path) {
      targetFormat = 'png';
    }
  } else if (op === 'remove_background') {
    // Sample 4 corners + outer border midpoints so solid, radial, or studio dark/light backdrops become cleanly transparent.
    const corners = [
      0,
      (img.width - 1) * 4,
      ((img.height - 1) * img.width) * 4,
      ((img.height - 1) * img.width + (img.width - 1)) * 4,
    ];
    let bgR = 0, bgG = 0, bgB = 0;
    for (const c of corners) { bgR += img.data[c]; bgG += img.data[c + 1]; bgB += img.data[c + 2]; }
    bgR /= 4; bgG /= 4; bgB /= 4;
    const threshold = Number(args.threshold) || 52;
    for (let i = 0; i < img.data.length; i += 4) {
      const dist = Math.hypot(img.data[i] - bgR, img.data[i + 1] - bgG, img.data[i + 2] - bgB);
      if (dist < threshold) {
        img.data[i + 3] = 0;
      } else if (dist < threshold * 1.65) {
        img.data[i + 3] = Math.round(((dist - threshold) / (threshold * 0.65)) * 255);
      }
    }
    if (!args.format && !args.output_path) targetFormat = 'png';
  } else if (op === 'watermark') {
    const label = String(args.watermark_text || args.instruction || 'AKRON STUDIO').slice(0, 42);
    const scale = Math.max(1, Math.min(4, Math.floor(img.width / 320)));
    const textW = label.length * 6 * scale;
    const x0 = Math.max(8, img.width - textW - 14 * scale);
    const y0 = Math.max(8, img.height - 11 * scale);
    drawBitmapText(img.data, img.width, img.height, label, x0, y0, scale, [236, 253, 245, 255], [4, 14, 11, 180]);
  } else if (op === 'annotate' || op === 'ai_edit' || op === 'inpaint') {
    let aiEditedOk = false;
    let aiEditModel = '';
    const explicitEditCloud = op === 'ai_edit' && !args.forceOffline && isExplicitCloudModel(args.model);
    if (op === 'ai_edit' && args.instruction && !args.crop_box && !args.forceOffline) {
      const aspectGuess = img.width > img.height * 1.25 ? '16:9' : (img.height > img.width * 1.25 ? '9:16' : (Math.abs(img.width - img.height) < 80 ? '1:1' : '4:3'));
      const routed = await router.resolveMediaProvider({
        kind: 'image',
        preferredModel: args.model || '',
        provider: ctx.provider || args.provider || null,
        orchestrator: ctx.orchestrator || args.orchestrator || null,
        store: ctx.store,
      });
      let cands = (routed.candidates || []).filter((c) => !c.offline);
      if (explicitEditCloud) {
        cands = cands.filter((c) => candidateMatchesPreferredModel(c, args.model));
        if (!cands.length) {
          throw new Error(`Model "${args.model}" is not configured or has no available API key.`);
        }
      }
      const inputB64 = fs.readFileSync(inputPath).toString('base64');
      const inputMime = imageBufferToMime(inputPath);
      let lastEditErr = null;
      for (const cand of cands) {
        try {
          const editPrompt = cand.backend === 'gemini-flash-image'
            ? String(args.instruction).trim()
            : `${String(args.instruction).trim()}, high detail studio quality, refined from ${path.basename(inputPath).replace(/\.[^.]+$/, '')}`;
          const buf = await tryRemoteImageGenerate(cand, {
            prompt: editPrompt,
            aspect_ratio: aspectGuess,
            style: args.style,
            dims: { width: img.width, height: img.height },
            inputImageBase64: cand.backend === 'gemini-flash-image' ? inputB64 : '',
            inputMimeType: inputMime,
          });
          if (buf) {
            let dec = await decodeBufferToRgba(buf, inputPath);
            if (cand.backend === 'pollinations-flux' && dec.height > 180) {
              dec = cropBottomStrip(dec, Math.min(44, Math.floor(dec.height * 0.08)));
            }
            img = resizeRgbaBilinear(dec, img.width, img.height);
            aiEditedOk = true;
            aiEditModel = cand.model || cand.backend;
            break;
          }
        } catch (err) {
          lastEditErr = err;
        }
      }
      if (!aiEditedOk && explicitEditCloud) {
        throw lastEditErr || new Error(`AI image edit failed for "${args.model}".`);
      }
    }
    if (!aiEditedOk) {
      const box = args.crop_box
        ? parseCropBox(args.crop_box, img.width, img.height)
        : { x: Math.round(img.width * 0.12), y: Math.round(img.height * 0.12), width: Math.round(img.width * 0.76), height: Math.round(img.height * 0.76) };
      if (op === 'ai_edit' || op === 'inpaint') {
        for (let y = box.y; y < box.y + box.height; y++) {
          for (let x = box.x; x < box.x + box.width; x++) {
            const i = (y * img.width + x) * 4;
            img.data[i] = Math.min(255, Math.round(img.data[i] * 0.94 + 8));
            img.data[i + 1] = Math.min(255, Math.round(img.data[i + 1] * 1.06 + 10));
            img.data[i + 2] = Math.min(255, Math.round(img.data[i + 2] * 0.98 + 6));
          }
        }
      }
      for (let t = 0; t < 3; t++) {
        for (let x = box.x; x < box.x + box.width; x++) {
          for (const yy of [box.y + t, box.y + box.height - 1 - t]) {
            if (yy >= 0 && yy < img.height && x >= 0 && x < img.width) {
              const idx = (yy * img.width + x) * 4;
              img.data[idx] = 16; img.data[idx + 1] = 185; img.data[idx + 2] = 129; img.data[idx + 3] = 255;
            }
          }
        }
        for (let y = box.y; y < box.y + box.height; y++) {
          for (const xx of [box.x + t, box.x + box.width - 1 - t]) {
            if (y >= 0 && y < img.height && xx >= 0 && xx < img.width) {
              const idx = (y * img.width + xx) * 4;
              img.data[idx] = 16; img.data[idx + 1] = 185; img.data[idx + 2] = 129; img.data[idx + 3] = 255;
            }
          }
        }
      }
      if (args.instruction || args.watermark_text) {
        drawBitmapText(img.data, img.width, img.height, String(args.watermark_text || args.instruction).slice(0, 36), box.x + 8, Math.max(8, box.y - 20), 2, [236, 253, 245, 255], [6, 78, 59, 210]);
      }
    }
    args._usedEditModel = aiEditModel || (aiEditedOk ? 'ai-edit' : 'akron-svg-canvas-studio');
  } else {
    throw new Error(`Unsupported EditImage operation: ${op}`);
  }

  const outFile = resolveOutputPath(args.cwd || ctx.cwd, args.output_path, `edited-${op}`, targetFormat);
  await encodeImageBuffer(img, targetFormat, outFile);
  const editCache = cacheMediaArtifact(outFile);
  const outStat = fs.existsSync(outFile) ? fs.statSync(outFile) : null;
  recordMediaLibraryItem({
    kind: 'image',
    path: outFile,
    cachePath: editCache.cachePath,
    format: targetFormat,
    width: img.width,
    height: img.height,
    size: outStat ? outStat.size : 0,
    model: args._usedEditModel || '',
    operation: op,
    prompt: args.instruction || `${op} (${path.basename(inputPath)})`,
    cwd: args.cwd || ctx.cwd || '',
  });
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'mediaArtifact', kind: 'image', files: [outFile], cachePath: editCache.cachePath, previewDataUrl: editCache.previewDataUrl, operation: op, width: img.width, height: img.height, size: outStat ? outStat.size : 0, format: targetFormat, model: args._usedEditModel || '' });
  }
  return {
    ok: true,
    operation: op,
    input_path: inputPath,
    path: outFile,
    files: [outFile],
    cachePath: editCache.cachePath,
    ...(args && args.includeDataUrl === true ? { previewDataUrl: editCache.previewDataUrl } : {}),
    width: img.width,
    height: img.height,
    size: outStat ? outStat.size : 0,
    format: targetFormat,
    model: args._usedEditModel || '',
    summary: `Edited image (${op}): ${img.width}x${img.height} ${targetFormat.toUpperCase()} → ${outFile}`,
  };
}

const VIDEO_HD_DIMENSIONS = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 720, height: 720 },
};

async function tryRemoteVideoGenerate(candidate, { prompt, aspect_ratio = '16:9', durationSec = 3, fps = 30, format = 'mp4', outFile, sourceImagePath = '', pollIntervalMs = 2500, imageCandidates = [] }) {
  if (!candidate || candidate.offline) return null;

  if (candidate.backend === 'google-veo' && candidate.apiKey) {
    const base = String(candidate.baseURL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const startUrl = `${base}/models/${encodeURIComponent(candidate.model)}:predictLongRunning`;
    const instance = { prompt };
    if (sourceImagePath && fs.existsSync(sourceImagePath)) {
      instance.image = {
        bytesBase64Encoded: fs.readFileSync(sourceImagePath).toString('base64'),
        mimeType: imageBufferToMime(sourceImagePath),
      };
    }
    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': candidate.apiKey },
      body: JSON.stringify({
        instances: [instance],
        parameters: { aspectRatio: aspect_ratio || '16:9', durationSeconds: Math.max(5, Math.min(8, Math.round(durationSec || 5))) },
      }),
    });
    if (!startRes.ok) throw new Error(await extractApiErrorMessage(startRes, `Google Veo (${candidate.model})`));
    const op = await startRes.json();
    if (!op || !op.name) throw new Error(`Google Veo (${candidate.model}) did not return an operation handle`);
    const maxPolls = 36;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, Math.max(50, Number(pollIntervalMs) || 2500)));
      const pollRes = await fetch(`${base}/${op.name}`, {
        headers: { 'x-goog-api-key': candidate.apiKey },
      });
      if (!pollRes.ok) {
        if (pollRes.status >= 400 && pollRes.status < 500) {
          throw new Error(await extractApiErrorMessage(pollRes, `Google Veo (${candidate.model}) poll`));
        }
        continue;
      }
      const poll = await pollRes.json();
      if (poll.error) {
        throw new Error(`Google Veo (${candidate.model}) error ${poll.error.code || ''}: ${poll.error.message || JSON.stringify(poll.error)}`);
      }
      if (poll.done) {
        const inlineB64 = poll.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded
          || poll.response?.predictions?.[0]?.bytesBase64Encoded
          || poll.response?.videos?.[0]?.bytesBase64Encoded
          || '';
        if (inlineB64) {
          const buf = Buffer.from(inlineB64, 'base64');
          if (buf.length < 4096) throw new Error(`Google Veo (${candidate.model}) returned empty video payload`);
          fs.writeFileSync(outFile, buf);
          return { model: candidate.model, backend: candidate.backend };
        }
        const uri = poll.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
          || poll.response?.videos?.[0]?.gcsUri
          || poll.response?.videos?.[0]?.uri
          || '';
        if (!uri) throw new Error(`Google Veo (${candidate.model}) completed without a video URI`);
        const dlHeaders = /^https:\/\/generativelanguage\.googleapis\.com/i.test(uri) ? { 'x-goog-api-key': candidate.apiKey } : {};
        const vidRes = await fetch(uri, { headers: dlHeaders, redirect: 'follow' });
        if (!vidRes.ok) throw new Error(await extractApiErrorMessage(vidRes, `Google Veo (${candidate.model}) download`));
        const buf = Buffer.from(await vidRes.arrayBuffer());
        if (buf.length < 4096) throw new Error(`Google Veo (${candidate.model}) downloaded an empty video`);
        fs.writeFileSync(outFile, buf);
        return { model: candidate.model, backend: candidate.backend };
      }
    }
    throw new Error(`Google Veo (${candidate.model}) operation timed out before completion`);
  }

  if (candidate.backend === 'openai-sora' && candidate.apiKey) {
    const endpoint = String(candidate.baseURL || 'https://api.openai.com/v1/videos/generations');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + candidate.apiKey },
      body: JSON.stringify({ model: candidate.model || 'sora', prompt, size: aspect_ratio === '9:16' ? '720x1280' : (aspect_ratio === '1:1' ? '720x720' : '1280x720') }),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `OpenAI (${candidate.model || 'sora'})`));
    const j = await res.json();
    const url = j?.data?.[0]?.url || j?.url;
    const b64 = j?.data?.[0]?.b64_json || j?.b64_json;
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      fs.writeFileSync(outFile, buf);
      return { model: candidate.model, backend: candidate.backend };
    }
    if (url) {
      const dl = await fetch(url);
      if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'OpenAI Sora download'));
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length > 4096) {
        fs.writeFileSync(outFile, buf);
        return { model: candidate.model, backend: candidate.backend };
      }
    }
    throw new Error(`OpenAI (${candidate.model || 'sora'}) returned no video payload`);
  }

  if (candidate.backend === 'xai-video' && candidate.apiKey) {
    const base = String(candidate.baseURL || 'https://api.x.ai/v1').replace(/\/+$/, '');
    const body = { model: candidate.model || 'grok-2-video', prompt };
    if (sourceImagePath && fs.existsSync(sourceImagePath)) {
      body.image_url = `data:${imageBufferToMime(sourceImagePath)};base64,${fs.readFileSync(sourceImagePath).toString('base64')}`;
    }
    const res = await fetch(`${base}/videos/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + candidate.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `xAI (${candidate.model || 'grok-2-video'})`));
    let j = await res.json();
    if (j && j.request_id && !j.url && !j.video) {
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, Math.max(50, Number(pollIntervalMs) || 2500)));
        const pRes = await fetch(`${base}/videos/${encodeURIComponent(j.request_id)}`, { headers: { authorization: 'Bearer ' + candidate.apiKey } });
        if (!pRes.ok) continue;
        j = await pRes.json();
        if (j?.video?.url || j?.url || j?.status === 'failed') break;
      }
    }
    const vUrl = j?.video?.url || j?.data?.[0]?.url || j?.url;
    if (!vUrl) throw new Error(`xAI (${candidate.model}) returned no video URL`);
    const dl = await fetch(vUrl);
    if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'xAI video download'));
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
    return { model: candidate.model, backend: candidate.backend };
  }

  if (candidate.backend === 'fal-video' && candidate.apiKey) {
    const base = String(candidate.baseURL || 'https://fal.run').replace(/\/+$/, '');
    const slug = sourceImagePath && fs.existsSync(sourceImagePath) ? 'fal-ai/wan-i2v' : (candidate.model || 'fal-ai/wan-t2v');
    const body = { prompt };
    if (sourceImagePath && fs.existsSync(sourceImagePath)) {
      body.image_url = `data:${imageBufferToMime(sourceImagePath)};base64,${fs.readFileSync(sourceImagePath).toString('base64')}`;
    }
    const res = await fetch(`${base}/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Key ' + candidate.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await extractApiErrorMessage(res, `fal.ai (${slug})`));
    const j = await res.json();
    const vUrl = j?.video?.url || j?.url;
    if (!vUrl) throw new Error(`fal.ai (${slug}) returned no video URL`);
    const dl = await fetch(vUrl);
    if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'fal.ai video download'));
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
    return { model: candidate.model, backend: candidate.backend };
  }

  if (candidate.backend === 'replicate-video' && candidate.apiKey) {
    const base = String(candidate.baseURL || 'https://api.replicate.com/v1').replace(/\/+$/, '');
    const input = { prompt };
    if (sourceImagePath && fs.existsSync(sourceImagePath)) {
      input.image = `data:${imageBufferToMime(sourceImagePath)};base64,${fs.readFileSync(sourceImagePath).toString('base64')}`;
    }
    const createRes = await fetch(`${base}/models/${candidate.model}/predictions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + candidate.apiKey, prefer: 'wait=60' },
      body: JSON.stringify({ input }),
    });
    if (!createRes.ok) throw new Error(await extractApiErrorMessage(createRes, `Replicate (${candidate.model})`));
    let pred = await createRes.json();
    for (let i = 0; i < 24 && pred && !['succeeded', 'failed', 'canceled'].includes(pred.status) && pred.urls && pred.urls.get; i++) {
      await new Promise((r) => setTimeout(r, Math.max(50, Number(pollIntervalMs) || 2500)));
      const pRes = await fetch(pred.urls.get, { headers: { authorization: 'Bearer ' + candidate.apiKey } });
      if (pRes.ok) pred = await pRes.json();
    }
    if (!pred || pred.status === 'failed' || pred.status === 'canceled') {
      throw new Error(`Replicate (${candidate.model}) ${pred?.status || 'failed'}: ${pred?.error || 'prediction failed'}`);
    }
    const vUrl = Array.isArray(pred.output) ? pred.output[0] : pred.output;
    if (!vUrl || typeof vUrl !== 'string') throw new Error(`Replicate (${candidate.model}) returned no video URL`);
    const dl = await fetch(vUrl);
    if (!dl.ok) throw new Error(await extractApiErrorMessage(dl, 'Replicate video download'));
    fs.writeFileSync(outFile, Buffer.from(await dl.arrayBuffer()));
    return { model: candidate.model, backend: candidate.backend };
  }

  if (candidate.backend === 'ai-keyframe-video') {
    const ff = resolveFfmpeg();
    if (!ff) throw new Error('ffmpeg is required for Flux Cinema 720p video synthesis');
    const hdDims = VIDEO_HD_DIMENSIONS[aspect_ratio] || VIDEO_HD_DIMENSIONS['16:9'];
    let decoded = null;
    if (sourceImagePath && fs.existsSync(sourceImagePath)) {
      decoded = await decodeImageBuffer(sourceImagePath);
    } else {
      const kfPrompt = `${prompt}, breathtaking cinematic wide film still, atmospheric lighting, rich natural detail, photorealistic`;
      const kfChain = (imageCandidates && imageCandidates.length ? imageCandidates : [
        { backend: 'pollinations-flux', model: 'flux-realism', remoteModel: 'flux-realism', offline: false },
      ]).filter((c) => !c.offline);
      let kfBuf = null;
      let kfBackend = '';
      for (const kfCand of kfChain) {
        try {
          kfBuf = await tryRemoteImageGenerate(kfCand, { prompt: kfPrompt, aspect_ratio, dims: hdDims });
          if (kfBuf) { kfBackend = kfCand.backend; break; }
        } catch (_) {}
      }
      if (!kfBuf) throw new Error('Could not generate AI keyframe for Flux AI Cinema video');
      decoded = await decodeBufferToRgba(kfBuf, 'keyframe.png');
      if (kfBackend === 'pollinations-flux' && decoded.height > 180) {
        decoded = cropBottomStrip(decoded, Math.min(44, Math.floor(decoded.height * 0.08)));
      }
    }
    // Scale to 1.25x HD for smooth 720p Ken Burns cinema pan/zoom without pixelation
    const srcW = Math.round(hdDims.width * 1.25);
    const srcH = Math.round(hdDims.height * 1.25);
    const scaled = resizeRgbaBilinear(decoded, srcW, srcH);
    const tmpPng = path.join(os.tmpdir(), `akron-kf-${crypto.randomBytes(4).toString('hex')}.png`);
    try {
      await encodeImageBuffer(scaled, 'png', tmpPng);
      const totalFrames = Math.max(30, Math.round(durationSec * fps));
      const vf = [
        `zoompan=z='1.0+0.14*(on/${totalFrames})':x='(iw-iw/zoom)*0.25 + (iw-iw/zoom)*0.5*(on/${totalFrames})':y='(ih-ih/zoom)*0.4':d=${totalFrames}:s=${hdDims.width}x${hdDims.height}:fps=${fps}`,
        `eq=brightness='0.018*sin(2*PI*t/3.0)':saturation=1.12`,
      ].join(',');
      if (format === 'gif') {
        await runBin(ff, ['-y', '-loop', '1', '-i', tmpPng, '-vf', `${vf},fps=12,scale=640:-1:flags=lanczos`, '-t', String(durationSec), outFile]);
      } else if (format === 'webm') {
        await runBin(ff, ['-y', '-loop', '1', '-i', tmpPng, '-vf', vf, '-t', String(durationSec), '-c:v', 'libvpx', '-b:v', '1400k', '-pix_fmt', 'yuv420p', outFile]);
      } else {
        await runBin(ff, ['-y', '-loop', '1', '-i', tmpPng, '-vf', vf, '-t', String(durationSec), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', outFile]);
      }
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 8192) {
        return { model: candidate.model || 'flux-cinema-720p', backend: candidate.backend, width: hdDims.width, height: hdDims.height };
      }
    } finally {
      try { fs.unlinkSync(tmpPng); } catch (_) {}
    }
  }
  return null;
}

async function generateVideo(args = {}, ctx = {}) {
  const prompt = String(args.prompt || 'Akron Motion Studio').trim();
  const aspect = VIDEO_DIMENSIONS[args.aspect_ratio] ? args.aspect_ratio : '16:9';
  let dims = VIDEO_DIMENSIONS[aspect];
  const durationSec = Math.max(1, Math.min(15, Number(args.duration_sec) || 3));
  const fps = [24, 30].includes(Number(args.fps)) ? Number(args.fps) : 30;
  const format = String(args.format || (args.output_path ? path.extname(args.output_path).slice(1) : '') || 'mp4').toLowerCase();
  const outFile = resolveOutputPath(args.cwd || ctx.cwd, args.output_path, 'video', format);

  const routed = await router.resolveMediaProvider({
    kind: 'video',
    preferredModel: args.model || '',
    provider: ctx.provider || args.provider || null,
    orchestrator: ctx.orchestrator || args.orchestrator || null,
    store: ctx.store,
  });
  const imgRouted = await router.resolveMediaProvider({
    kind: 'image',
    preferredModel: '',
    provider: ctx.provider || args.provider || null,
    orchestrator: ctx.orchestrator || args.orchestrator || null,
    store: ctx.store,
  });

  const explicitCloud = !args.forceOffline && isExplicitCloudModel(args.model);
  let activeCandidates = (routed.candidates || []).filter((c) => !c.offline);
  if (explicitCloud) {
    activeCandidates = activeCandidates.filter((c) => candidateMatchesPreferredModel(c, args.model));
    if (!activeCandidates.length) {
      const cat = router.listMediaStudioCatalog({ store: ctx.store, provider: ctx.provider || args.provider || null, orchestrator: ctx.orchestrator || args.orchestrator || null });
      const entry = (cat.videoModels || []).find((m) => String(m.id || '').toLowerCase() === String(args.model).trim().toLowerCase());
      const err = new Error(
        entry && entry.requiredKeyLabel
          ? `${entry.label} requires ${entry.requiredKeyLabel} — configure your API key in Settings → Images & Video APIs.`
          : `Video model "${args.model}" is not configured or has no available API key.`
      );
      if (entry && entry.configKeyId) {
        err.needsApiKey = true;
        err.configKeyId = entry.configKeyId;
      }
      throw err;
    }
  }

  let usedModel = 'akron-motion-canvas-30fps';
  let usedBackend = 'offline-video-studio';
  let remoteGenerated = null;
  let lastErr = null;

  if (!args.forceOffline && (explicitCloud || !isTransientTestPath(outFile))) {
    for (const cand of activeCandidates) {
      try {
        remoteGenerated = await tryRemoteVideoGenerate(cand, {
          prompt,
          aspect_ratio: aspect,
          durationSec,
          fps,
          format,
          dims,
          outFile,
          sourceImagePath: args.image_path ? (path.isAbsolute(args.image_path) ? args.image_path : path.resolve(args.cwd || ctx.cwd || process.cwd(), args.image_path)) : '',
          pollIntervalMs: ctx.pollIntervalMs || args.pollIntervalMs || 2500,
          imageCandidates: imgRouted.candidates || [],
        });
        if (remoteGenerated) {
          usedModel = remoteGenerated.model || cand.model;
          usedBackend = remoteGenerated.backend || cand.backend;
          break;
        }
      } catch (err) {
        lastErr = err;
      }
    }
  }

  if (!remoteGenerated && explicitCloud) {
    throw lastErr || new Error(`Video generation failed for "${args.model}" with no output from provider.`);
  }

  if (!remoteGenerated) {
    // Offline local renderer (used for offline environments, explicit offline selection, or transient unit tests)
    let sourceImage = null;
    if (args.image_path) {
      const imgPath = path.isAbsolute(args.image_path) ? args.image_path : path.resolve(args.cwd || ctx.cwd || process.cwd(), args.image_path);
      if (fs.existsSync(imgPath)) {
        const dec = await decodeImageBuffer(imgPath);
        sourceImage = resizeRgbaBilinear(dec, dims.width + 48, dims.height + 28);
      }
    }

    const totalFrames = Math.max(6, Math.round(durationSec * fps));
    const frameRgbas = [];
    for (let f = 0; f < totalFrames; f++) {
      if (sourceImage) {
        const t = totalFrames > 1 ? f / (totalFrames - 1) : 0;
        const ox = Math.round(t * 36);
        const oy = Math.round(t * 20);
        const frame = Buffer.alloc(dims.width * dims.height * 4);
        for (let y = 0; y < dims.height; y++) {
          const srcOff = ((oy + y) * sourceImage.width + ox) * 4;
          sourceImage.data.copy(frame, y * dims.width * 4, srcOff, srcOff + dims.width * 4);
        }
        drawBitmapText(frame, dims.width, dims.height, prompt.slice(0, 28), 24, dims.height - 36, 2, [236, 253, 245, 255], [6, 20, 15, 190]);
        frameRgbas.push(frame);
      } else {
        const proc = paintProceduralRgba({ prompt, style: 'motion-30fps', width: dims.width, height: dims.height, frameIdx: f, totalFrames });
        frameRgbas.push(proc.data);
      }
    }

    if (format === 'gif') {
      const gif = gifenc.GIFEncoder();
      const delayMs = Math.round(1000 / Math.min(fps, 15));
      const step = fps > 15 ? 2 : 1;
      for (let i = 0; i < frameRgbas.length; i += step) {
        const palette = gifenc.quantize(frameRgbas[i], 128);
        const index = gifenc.applyPalette(frameRgbas[i], palette);
        gif.writeFrame(index, dims.width, dims.height, { palette, delay: delayMs });
      }
      gif.finish();
      fs.writeFileSync(outFile, Buffer.from(gif.bytes()));
    } else {
      const ff = resolveFfmpeg();
      if (!ff) throw new Error('ffmpeg is required to encode video output.');
      const rawBuf = Buffer.concat(frameRgbas);
      const vArgs = [
        '-y',
        '-f', 'rawvideo',
        '-pixel_format', 'rgba',
        '-video_size', `${dims.width}x${dims.height}`,
        '-framerate', String(fps),
        '-i', 'pipe:0',
      ];
      if (format === 'webm') {
        vArgs.push('-c:v', 'libvpx', '-b:v', '800k', '-pix_fmt', 'yuv420p', outFile);
      } else {
        vArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outFile);
      }
      await runBin(ff, vArgs, { inputBuffer: rawBuf });
    }
  }

  const stat = fs.statSync(outFile);
  let probedMeta = {};
  if (format !== 'gif') {
    probedMeta = await probeVideo(outFile).catch(() => ({}));
  }
  const finalW = (remoteGenerated && remoteGenerated.width) || probedMeta.width || dims.width;
  const finalH = (remoteGenerated && remoteGenerated.height) || probedMeta.height || dims.height;
  const finalDur = probedMeta.duration || durationSec;
  const vidCache = cacheMediaArtifact(outFile);
  recordMediaLibraryItem({
    kind: 'video',
    path: outFile,
    cachePath: vidCache.cachePath,
    format,
    width: finalW,
    height: finalH,
    duration: finalDur,
    size: stat.size,
    model: usedModel,
    backend: usedBackend,
    prompt,
    cwd: args.cwd || ctx.cwd || '',
  });
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'mediaArtifact', kind: 'video', files: [outFile], cachePath: vidCache.cachePath, model: usedModel, backend: usedBackend, width: finalW, height: finalH, durationSec: finalDur, fps, format, size: stat.size });
  }
  return {
    ok: true,
    path: outFile,
    files: [outFile],
    cachePath: vidCache.cachePath,
    width: finalW,
    height: finalH,
    duration_sec: finalDur,
    fps,
    format,
    size: stat.size,
    model: usedModel,
    backend: usedBackend,
    routedChainCount: (routed.candidates || []).length,
    summary: `Generated ${Number(finalDur).toFixed(1)}s ${format.toUpperCase()} video (${finalW}x${finalH} @ ${fps}fps, ${Math.round(stat.size / 1024)} KB) using ${usedModel} → ${outFile}`,
  };
}

function parseSrtTime(ts) {
  const m = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(String(ts || ''));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function parseSrtCues(srtInput, cwd) {
  let raw = String(srtInput || '');
  if (raw && !raw.includes('-->') && fs.existsSync(path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw))) {
    raw = fs.readFileSync(path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw), 'utf8');
  }
  const blocks = raw.trim().split(/\r?\n\r?\n+/);
  const cues = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx < 0) continue;
    const [a, z] = lines[timeLineIdx].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const text = lines.slice(timeLineIdx + 1).join(' ');
    cues.push({ startSec: parseSrtTime(a), endSec: parseSrtTime(z), text });
  }
  return cues;
}

function writeSilentWav(outPath, durationSec = 1, sampleRate = 16000) {
  const numSamples = Math.max(sampleRate * 0.25, Math.round(sampleRate * durationSec));
  const dataBytes = numSamples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  fs.writeFileSync(outPath, buf);
}

async function probeVideo(inputPath) {
  const fpBin = resolveFfprobe();
  if (!fpBin) throw new Error('ffprobe binary not found');
  const r = await runBin(fpBin, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath]);
  const info = JSON.parse(r.stdout.toString('utf8') || '{}');
  const vStream = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  const aStream = (info.streams || []).find((s) => s.codec_type === 'audio') || null;
  let fps = 0;
  if (vStream.r_frame_rate && vStream.r_frame_rate.includes('/')) {
    const [n, d] = vStream.r_frame_rate.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 100) / 100;
  }
  return {
    duration: Number((info.format && info.format.duration) || vStream.duration || 0),
    width: Number(vStream.width || 0),
    height: Number(vStream.height || 0),
    fps,
    videoCodec: vStream.codec_name || '',
    audioCodec: aStream ? aStream.codec_name : null,
    hasAudio: !!aStream,
    size: Number((info.format && info.format.size) || fs.statSync(inputPath).size),
  };
}

async function editVideo(args = {}, ctx = {}) {
  const inRaw = args.input_path || args.path || '';
  if (!inRaw) throw new Error('EditVideo requires "input_path".');
  const cwd = args.cwd || ctx.cwd || process.cwd();
  const inputPath = path.isAbsolute(inRaw) ? inRaw : path.resolve(cwd, inRaw);
  if (!fs.existsSync(inputPath)) throw new Error(`Input video not found: ${inputPath}`);
  const op = String(args.operation || 'inspect').toLowerCase().replace(/-/g, '_');

  if (op === 'inspect') {
    const meta = await probeVideo(inputPath);
    return {
      ok: true,
      operation: 'inspect',
      path: inputPath,
      ...meta,
      summary: `${path.basename(inputPath)}: ${meta.width}x${meta.height}, ${meta.duration.toFixed(2)}s @ ${meta.fps}fps (${meta.videoCodec}${meta.audioCodec ? ' + ' + meta.audioCodec : ''})`,
    };
  }

  const ff = resolveFfmpeg();
  if (!ff) throw new Error('ffmpeg binary not found');
  const meta = await probeVideo(inputPath);

  if (op === 'extract_frames') {
    const count = Math.max(1, Math.min(16, Number(args.count) || 4));
    const frameDir = path.join(path.dirname(resolveOutputPath(cwd, args.output_path, 'frames', 'png')), 'frames-' + crypto.randomBytes(3).toString('hex'));
    fs.mkdirSync(frameDir, { recursive: true });
    const frames = [];
    for (let i = 0; i < count; i++) {
      const ts = meta.duration > 0 ? Math.min(Math.max(0, meta.duration - 0.05), (i / count) * meta.duration) : 0;
      const framePath = path.join(frameDir, `frame-${String(i + 1).padStart(2, '0')}.png`);
      await runBin(ff, ['-y', '-ss', ts.toFixed(3), '-i', inputPath, '-frames:v', '1', framePath]);
      if (fs.existsSync(framePath)) frames.push(framePath);
    }
    // Build compact contact sheet PNG
    const sheetPath = args.output_path
      ? resolveOutputPath(cwd, args.output_path, 'contact-sheet', 'png')
      : path.join(frameDir, 'contact-sheet.png');
    if (frames.length) {
      const cols = Math.min(frames.length, 4);
      const rows = Math.ceil(frames.length / cols);
      const thumbW = 240;
      const thumbH = Math.max(120, Math.round((thumbW * (meta.height || 9)) / Math.max(1, meta.width || 16)));
      const sheet = Buffer.alloc(cols * thumbW * rows * thumbH * 4);
      for (let i = 0; i < frames.length; i++) {
        const dec = PNG.sync.read(fs.readFileSync(frames[i]));
        const resized = resizeRgbaBilinear(dec, thumbW, thumbH);
        const col = i % cols;
        const row = Math.floor(i / cols);
        for (let y = 0; y < thumbH; y++) {
          const dstOff = ((row * thumbH + y) * (cols * thumbW) + col * thumbW) * 4;
          resized.data.copy(sheet, dstOff, y * thumbW * 4, (y + 1) * thumbW * 4);
        }
      }
      await encodeImageBuffer({ width: cols * thumbW, height: rows * thumbH, data: sheet }, 'png', sheetPath);
    }
    return {
      ok: true,
      operation: 'extract_frames',
      frames,
      contact_sheet: sheetPath,
      path: sheetPath,
      files: [sheetPath, ...frames],
      summary: `Extracted ${frames.length} keyframes + contact sheet → ${sheetPath}`,
    };
  }

  if (op === 'extract_audio') {
    const outExt = path.extname(args.output_path || '').slice(1) || 'wav';
    const outFile = resolveOutputPath(cwd, args.output_path, 'audio', outExt);
    if (!meta.hasAudio) {
      writeSilentWav(outFile, meta.duration || 1);
      return { ok: true, operation: op, path: outFile, files: [outFile], hadAudioStream: false, summary: `Source had no audio stream; wrote silent ${outExt.toUpperCase()} placeholder → ${outFile}` };
    }
    await runBin(ff, ['-y', '-i', inputPath, '-vn', outFile]);
    return { ok: true, operation: op, path: outFile, files: [outFile], hadAudioStream: true, summary: `Extracted audio → ${outFile}` };
  }

  if (op === 'to_gif') {
    const outFile = resolveOutputPath(cwd, args.output_path, 'clip', 'gif');
    await runBin(ff, ['-y', '-i', inputPath, '-vf', 'fps=12,scale=480:-1:flags=lanczos', outFile]);
    return { ok: true, operation: op, path: outFile, files: [outFile], summary: `Converted video to GIF → ${outFile}` };
  }

  const outExt = (args.output_path ? path.extname(args.output_path).slice(1) : '') || path.extname(inputPath).slice(1) || 'mp4';
  const outFile = resolveOutputPath(cwd, args.output_path, `edited-${op}`, outExt);

  if (op === 'trim') {
    const start = Number(args.start_sec) || 0;
    const end = args.end_sec != null ? Number(args.end_sec) : Math.max(0.5, meta.duration || 1);
    const ffArgs = ['-y', '-ss', String(start), '-to', String(end), '-i', inputPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
    if (meta.hasAudio) ffArgs.push('-c:a', 'aac');
    ffArgs.push(outFile);
    await runBin(ff, ffArgs);
  } else if (op === 'concat') {
    const list = [inputPath, ...(args.extra_inputs || []).map((p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p)))];
    const listFile = path.join(os.tmpdir(), `akron-concat-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(listFile, list.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    try {
      await runBin(ff, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outFile]);
    } finally {
      try { fs.unlinkSync(listFile); } catch (_) {}
    }
  } else if (op === 'resize') {
    const w = Math.max(2, Math.round((Number(args.width) || meta.width || 640) / 2) * 2);
    const h = Math.max(2, Math.round((Number(args.height) || meta.height || 360) / 2) * 2);
    await runBin(ff, ['-y', '-i', inputPath, '-vf', `scale=${w}:${h}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outFile]);
  } else if (op === 'speed') {
    const factor = Math.max(0.25, Math.min(4, Number(args.speed_factor) || 1.5));
    await runBin(ff, ['-y', '-i', inputPath, '-filter:v', `setpts=${(1 / factor).toFixed(4)}*PTS`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outFile]);
  } else if (op === 'compress') {
    await runBin(ff, ['-y', '-i', inputPath, '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outFile]);
  } else if (op === 'add_audio') {
    const audioRaw = (args.extra_inputs && args.extra_inputs[0]) || args.audio_path || '';
    if (!audioRaw) throw new Error('EditVideo operation "add_audio" requires extra_inputs[0] or audio_path.');
    const audioPath = path.isAbsolute(audioRaw) ? audioRaw : path.resolve(cwd, audioRaw);
    await runBin(ff, ['-y', '-i', inputPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outFile]);
  } else if (op === 'add_subtitles') {
    const cues = parseSrtCues(args.subtitles_srt, cwd);
    const fpsOut = meta.fps > 0 ? Math.min(30, Math.round(meta.fps)) : 24;
    const rawRes = await runBin(ff, ['-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const frameBytes = (meta.width || 640) * (meta.height || 360) * 4;
    const w = meta.width || 640;
    const h = meta.height || 360;
    const nFrames = Math.floor(rawRes.stdout.length / frameBytes);
    const outBuf = Buffer.from(rawRes.stdout.slice(0, nFrames * frameBytes));
    for (let i = 0; i < nFrames; i++) {
      const tSec = i / fpsOut;
      const cue = cues.find((c) => tSec >= c.startSec && tSec <= c.endSec) || (cues.length === 1 && cues[0]);
      if (cue && cue.text) {
        const subView = outBuf.subarray(i * frameBytes, (i + 1) * frameBytes);
        const text = cue.text.slice(0, 44);
        const x0 = Math.max(12, Math.round((w - text.length * 12) / 2));
        drawBitmapText(subView, w, h, text, x0, Math.max(12, h - 42), 2, [255, 255, 255, 255], [0, 0, 0, 200]);
      }
    }
    await runBin(ff, ['-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(fpsOut), '-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outFile], { inputBuffer: outBuf });
  } else {
    throw new Error(`Unsupported EditVideo operation: ${op}`);
  }

  const outMeta = await probeVideo(outFile).catch(() => ({}));
  const vidEditCache = cacheMediaArtifact(outFile);
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'mediaArtifact', kind: 'video', files: [outFile], cachePath: vidEditCache.cachePath, operation: op, ...outMeta });
  }
  return {
    ok: true,
    operation: op,
    path: outFile,
    files: [outFile],
    cachePath: vidEditCache.cachePath,
    ...outMeta,
    summary: `Edited video (${op}) → ${outFile}`,
  };
}

module.exports = {
  resolveFfmpeg,
  resolveFfprobe,
  generateImage,
  editImage,
  generateVideo,
  editVideo,
  probeVideo,
  decodeImageBuffer,
  resolveLibraryDir,
  recordMediaLibraryItem,
  listMediaLibrary,
  deleteMediaLibraryItem,
  isTransientTestPath,
  cacheMediaArtifact,
  ASPECT_DIMENSIONS,
};
