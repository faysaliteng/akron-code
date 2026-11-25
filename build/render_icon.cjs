#!/usr/bin/env node
/**
 * Icon pipeline for Akron Bot.
 *
 *   npm run icons            # or: npx electron build/render_icon.cjs
 *
 * Rasterizes build/icon.svg and build/tray.svg with Chromium (the same engine
 * that renders the in-app mark), so gradients, filters and rounded corners come
 * out exactly as designed. Outputs:
 *
 *   build/icon.png                    1024×1024 app icon
 *   build/icon.iconset/*              Apple iconset (16…1024)
 *   build/icon.icns                   via `iconutil`
 *   electron/trayTemplate.png         16px menu-bar template image
 *   electron/trayTemplate@2x.png      32px menu-bar template image
 *
 * No ImageMagick / librsvg / Python dependency: Electron ships Chromium.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ICON_SVG = path.join(__dirname, 'icon.svg');
const TRAY_SVG = path.join(__dirname, 'tray.svg');

const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function rasterize(win, svg, size) {
  const script = `(async () => {
    const svg = ${JSON.stringify(svg)};
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('svg decode failed'));
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    });
    const c = document.createElement('canvas');
    c.width = ${size}; c.height = ${size};
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, ${size}, ${size});
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`;
  return win.webContents.executeJavaScript(script, true);
}

function writeDataUrl(file, dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return fs.statSync(file).size;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { contextIsolation: false, nodeIntegration: false, offscreen: true },
  });
  let failed = false;
  try {
    await win.loadURL('about:blank');
    const iconSvg = fs.readFileSync(ICON_SVG, 'utf8');
    const traySvg = fs.readFileSync(TRAY_SVG, 'utf8');

    // App icon + Apple iconset
    const icon1024 = await rasterize(win, iconSvg, 1024);
    console.log('build/icon.png', writeDataUrl(path.join(__dirname, 'icon.png'), icon1024), 'bytes');

    fs.rmSync(path.join(__dirname, 'icon.iconset'), { recursive: true, force: true });
    fs.mkdirSync(path.join(__dirname, 'icon.iconset'), { recursive: true });
    for (const [name, size] of ICONSET) {
      const out = path.join(__dirname, 'icon.iconset', name);
      console.log('icon.iconset/' + name, writeDataUrl(out, await rasterize(win, iconSvg, size)), 'bytes');
    }
    try {
      execFileSync('iconutil', ['-c', 'icns', path.join(__dirname, 'icon.iconset'), '-o', path.join(__dirname, 'icon.icns')]);
      console.log('build/icon.icns', fs.statSync(path.join(__dirname, 'icon.icns')).size, 'bytes');
    } catch (e) {
      console.error('iconutil failed:', e.message);
      failed = true;
    }

    // Menu-bar template image (black + alpha, macOS inverts it per appearance)
    console.log('electron/trayTemplate.png', writeDataUrl(path.join(ROOT, 'electron', 'trayTemplate.png'), await rasterize(win, traySvg, 16)), 'bytes');
    console.log('electron/trayTemplate@2x.png', writeDataUrl(path.join(ROOT, 'electron', 'trayTemplate@2x.png'), await rasterize(win, traySvg, 32)), 'bytes');
  } catch (e) {
    console.error('icon render failed:', e && e.stack ? e.stack : e);
    failed = true;
  } finally {
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
