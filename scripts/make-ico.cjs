'use strict';
// Generates build/icon.ico (multi-size PNG-in-ICO: 16, 32, 48, 64, 128, 256)
// from build/icon.png so electron-builder can package Windows executables cleanly.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcPng = path.join(root, 'build', 'icon.png');
const outIco = path.join(root, 'build', 'icon.ico');
const sizes = [16, 32, 48, 64, 128, 256];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ico-'));
try {
  const frames = sizes.map((sz) => {
    const out = path.join(tmpDir, `icon-${sz}.png`);
    execFileSync('sips', ['-z', String(sz), String(sz), srcPng, '--out', out], { stdio: 'ignore' });
    return { sz, data: fs.readFileSync(out) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(frames.length, 4);

  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach((f, idx) => {
    const base = idx * 16;
    dir[base] = f.sz >= 256 ? 0 : f.sz;
    dir[base + 1] = f.sz >= 256 ? 0 : f.sz;
    dir[base + 2] = 0; // palette
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // planes
    dir.writeUInt16LE(32, base + 6); // bpp
    dir.writeUInt32LE(f.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += f.data.length;
  });

  fs.writeFileSync(outIco, Buffer.concat([header, dir, ...frames.map((f) => f.data)]));
  console.log('Generated', outIco, fs.statSync(outIco).size, 'bytes');
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}
