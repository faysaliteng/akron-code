'use strict';
// Cross-platform standalone Akron Browser Bot manager, RSA-2048 CRX3 packager,
// OS default browser detector, and 1-click External Extensions auto-installer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const AdmZip = require('adm-zip');

const EXTENSION_FOLDER_NAME = 'Akron Browser Bot';
const BUNDLE_IGNORE_NAMES = new Set(['.gitattributes', '.gitignore', '.DS_Store', 'node_modules', 'package-lock.json']);

function uint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function encodeVarint(num) {
  const bytes = [];
  let n = Number(num) >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function encodeBytesField(fieldNumber, payload) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  const len = encodeVarint(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function getBundledSourceExtensionDir({ resourcesPath = process.resourcesPath, fsMod = fs } = {}) {
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'akron-browser-bot') : null,
    path.join(__dirname, '..', 'resources', 'akron-browser-bot'),
  ].filter(Boolean);
  for (const d of candidates) {
    try { if (fsMod.existsSync(d) && fsMod.existsSync(path.join(d, 'manifest.json'))) return d; } catch (_) {}
  }
  return candidates[candidates.length - 1];
}

function resolveStandaloneExtensionDir({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  fsMod = fs,
  ensureWritable = true,
} = {}) {
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(path.join(homeDir, 'Applications', EXTENSION_FOLDER_NAME));
    candidates.push(path.join(homeDir, 'Documents', EXTENSION_FOLDER_NAME));
  } else if (platform === 'win32') {
    const localAppData = (env && env.LOCALAPPDATA) || path.join(homeDir, 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'AkronLogic', EXTENSION_FOLDER_NAME));
    candidates.push(path.join(homeDir, 'Documents', EXTENSION_FOLDER_NAME));
  } else {
    candidates.push(path.join(homeDir, EXTENSION_FOLDER_NAME));
    const xdg = (env && env.XDG_DATA_HOME) || path.join(homeDir, '.local', 'share');
    candidates.push(path.join(xdg, EXTENSION_FOLDER_NAME));
  }
  if (!ensureWritable) return candidates[0];
  for (const dir of candidates) {
    try {
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {}
  }
  return candidates[candidates.length - 1];
}

function loadOrCreateSigningKey(keyPath = path.join(os.homedir(), '.autobot', 'browser-ext-key.pem'), fsMod = fs) {
  try {
    if (keyPath && fsMod.existsSync(keyPath)) {
      const existing = fsMod.readFileSync(keyPath, 'utf8');
      const priv = crypto.createPrivateKey(existing);
      const pub = crypto.createPublicKey(priv);
      const spkiDer = pub.export({ type: 'spki', format: 'der' });
      return { privateKeyPem: existing, spkiDer };
    }
  } catch (_) {}

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  if (keyPath) {
    try {
      fsMod.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      fsMod.writeFileSync(keyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
  }
  return { privateKeyPem: privateKey, spkiDer: Buffer.from(publicKey) };
}

function computeExtensionIdFromPublicKeyDer(spkiDer) {
  const hash = crypto.createHash('sha256').update(spkiDer).digest().subarray(0, 16);
  const chars = [];
  const aCode = 'a'.charCodeAt(0);
  for (const byte of hash) {
    chars.push(String.fromCharCode(aCode + ((byte >> 4) & 0x0f)));
    chars.push(String.fromCharCode(aCode + (byte & 0x0f)));
  }
  return chars.join('');
}

function collectExtensionFiles(dir, relBase = '', fsMod = fs) {
  const out = [];
  const entries = fsMod.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (BUNDLE_IGNORE_NAMES.has(ent.name)) continue;
    if (/\.crx$/i.test(ent.name) || ent.name === 'HOW_TO_INSTALL.txt') continue;
    const abs = path.join(dir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...collectExtensionFiles(abs, rel, fsMod));
    } else if (ent.isFile()) {
      out.push({ abs, rel });
    }
  }
  return out;
}

function buildCrx3Package({
  sourceDir = getBundledSourceExtensionDir(),
  outCrxPath = '',
  keyPath = path.join(os.homedir(), '.autobot', 'browser-ext-key.pem'),
  keyPem = '',
  fsMod = fs,
} = {}) {
  let privateKeyPem = keyPem;
  let spkiDer;
  if (privateKeyPem) {
    spkiDer = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' });
  } else {
    const k = loadOrCreateSigningKey(keyPath, fsMod);
    privateKeyPem = k.privateKeyPem;
    spkiDer = k.spkiDer;
  }

  const extensionId = computeExtensionIdFromPublicKeyDer(spkiDer);
  const pubKeyBase64 = Buffer.from(spkiDer).toString('base64');
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const manifest = JSON.parse(fsMod.readFileSync(manifestPath, 'utf8'));
  const patchedManifest = { ...manifest, key: pubKeyBase64 };
  const manifestBuf = Buffer.from(JSON.stringify(patchedManifest, null, 2) + '\n', 'utf8');

  const zip = new AdmZip();
  const files = collectExtensionFiles(sourceDir, '', fsMod);
  for (const f of files) {
    if (f.rel === 'manifest.json') {
      zip.addFile('manifest.json', manifestBuf);
    } else {
      zip.addFile(f.rel, fsMod.readFileSync(f.abs));
    }
  }
  const zipBuffer = zip.toBuffer();

  // CRX3 protobuf: SignedData { 1: crx_id (16 bytes) }
  const crxId = crypto.createHash('sha256').update(spkiDer).digest().subarray(0, 16);
  const signedDataBytes = encodeBytesField(1, crxId);

  const prefix = Buffer.from('CRX3 SignedData\x00', 'binary');
  const signedPayload = Buffer.concat([prefix, uint32LE(signedDataBytes.length), signedDataBytes, zipBuffer]);
  const signature = crypto.sign('sha256', signedPayload, privateKeyPem);

  // AsymmetricKeyProof { 1: public_key, 2: signature }
  const proofBytes = Buffer.concat([
    encodeBytesField(1, spkiDer),
    encodeBytesField(2, signature),
  ]);
  // CrxFileHeader { 2: sha256_with_rsa (proof), 10000: signed_header_data }
  const headerBytes = Buffer.concat([
    encodeBytesField(2, proofBytes),
    encodeBytesField(10000, signedDataBytes),
  ]);

  const crxBuffer = Buffer.concat([
    Buffer.from('Cr24', 'ascii'),
    uint32LE(3),
    uint32LE(headerBytes.length),
    headerBytes,
    zipBuffer,
  ]);

  if (outCrxPath) {
    fsMod.mkdirSync(path.dirname(outCrxPath), { recursive: true });
    fsMod.writeFileSync(outCrxPath, crxBuffer);
  }

  return {
    ok: true,
    extensionId,
    version: String(manifest.version || '1.0.0'),
    crxPath: outCrxPath,
    crxSize: crxBuffer.length,
    crxBuffer,
    patchedManifestBuffer: manifestBuf,
  };
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, nextOffset: pos };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error('Malformed protobuf varint');
}

function parseProtoFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.nextOffset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;
    if (wireType !== 2) throw new Error(`Unsupported wire type ${wireType}`);
    const len = readVarint(buf, pos);
    pos = len.nextOffset;
    const end = pos + len.value;
    if (end > buf.length) throw new Error('Truncated protobuf field');
    fields.push({ fieldNumber, value: buf.subarray(pos, end) });
    pos = end;
  }
  return fields;
}

function verifyCrx3Package(crxInput) {
  const buf = typeof crxInput === 'string' ? fs.readFileSync(crxInput) : Buffer.from(crxInput || []);
  if (buf.length < 16) return { ok: false, error: 'CRX buffer too small' };
  if (buf.subarray(0, 4).toString('ascii') !== 'Cr24') return { ok: false, error: 'Bad CRX magic' };
  const version = buf.readUInt32LE(4);
  if (version !== 3) return { ok: false, error: `Expected CRX3 version 3, got ${version}` };
  const headerLen = buf.readUInt32LE(8);
  const headerEnd = 12 + headerLen;
  if (headerEnd > buf.length) return { ok: false, error: 'Truncated CRX3 header' };

  const headerBytes = buf.subarray(12, headerEnd);
  const zipBytes = buf.subarray(headerEnd);
  const headerFields = parseProtoFields(headerBytes);
  const rsaProof = headerFields.find((f) => f.fieldNumber === 2);
  const signedHeaderField = headerFields.find((f) => f.fieldNumber === 10000);
  if (!rsaProof || !signedHeaderField) return { ok: false, error: 'Missing CRX3 proof or signed header' };

  const proofFields = parseProtoFields(rsaProof.value);
  const pubKeyField = proofFields.find((f) => f.fieldNumber === 1);
  const sigField = proofFields.find((f) => f.fieldNumber === 2);
  if (!pubKeyField || !sigField) return { ok: false, error: 'Missing public key or signature in proof' };

  const signedFields = parseProtoFields(signedHeaderField.value);
  const crxIdField = signedFields.find((f) => f.fieldNumber === 1);
  if (!crxIdField || crxIdField.value.length !== 16) return { ok: false, error: 'Invalid CRX3 crx_id' };

  const expectedCrxId = crypto.createHash('sha256').update(pubKeyField.value).digest().subarray(0, 16);
  if (!expectedCrxId.equals(crxIdField.value)) return { ok: false, error: 'crx_id mismatch' };

  const signedPayload = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'binary'),
    uint32LE(signedHeaderField.value.length),
    signedHeaderField.value,
    zipBytes,
  ]);
  const pubKey = crypto.createPublicKey({ key: pubKeyField.value, format: 'der', type: 'spki' });
  const verified = crypto.verify('sha256', signedPayload, pubKey, sigField.value);
  if (!verified) return { ok: false, error: 'RSA-SHA256 signature verification failed' };

  const zip = new AdmZip(zipBytes);
  const manifestEntry = zip.getEntries().find((e) => e.entryName === 'manifest.json');
  if (!manifestEntry) return { ok: false, error: 'manifest.json missing inside CRX3 ZIP' };
  const parsedManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  return {
    ok: true,
    version: 3,
    extensionVersion: parsedManifest.version,
    extensionId: computeExtensionIdFromPublicKeyDer(pubKeyField.value),
    entryCount: zip.getEntries().length,
  };
}

function buildHowToInstallText(standaloneDir, extensionId) {
  return [
    'Akron Browser Bot — Standalone Extension Folder',
    '=================================================',
    '',
    `Folder Location : ${standaloneDir}`,
    `Extension ID    : ${extensionId}`,
    `CRX3 Package    : ${path.join(standaloneDir, 'akron-browser-bot.crx')}`,
    '',
    'Automatic Setup:',
    '  Click "Add Akron Web Bot" in Akron Code → Settings → Browser Extension,',
    '  or click "Launch Browser with Web Bot Pre-Loaded".',
    '',
    'Manual 10-Second Unpacked Load (Chrome / Brave / Edge / Arc / Vivaldi):',
    '  1. Open chrome://extensions (or brave://extensions / edge://extensions)',
    '  2. Enable "Developer mode" (top right)',
    '  3. Click "Load unpacked" and pick THIS folder:',
    `     ${standaloneDir}`,
    '',
  ].join('\n');
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function syncStandaloneExtension({
  sourceDir = getBundledSourceExtensionDir(),
  targetDir = '',
  keyPath = path.join(os.homedir(), '.autobot', 'browser-ext-key.pem'),
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  force = false,
  fsMod = fs,
} = {}) {
  const destDir = targetDir || resolveStandaloneExtensionDir({ platform, homeDir, env, fsMod });
  if (!sourceDir || !fsMod.existsSync(sourceDir)) {
    return { ok: false, error: 'Bundled extension source folder not found', extensionDir: destDir };
  }
  const srcManifest = JSON.parse(fsMod.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const crxPath = path.join(destDir, 'akron-browser-bot.crx');
  const destManifestPath = path.join(destDir, 'manifest.json');

  // Never downgrade an already auto-updated user folder (e.g. GitHub auto-update 1.6.11 > bundled 1.6.10).
  if (!force && fsMod.existsSync(destManifestPath) && fsMod.existsSync(crxPath)) {
    try {
      const dm = JSON.parse(fsMod.readFileSync(destManifestPath, 'utf8'));
      if (dm && dm.key && dm.version && compareSemver(dm.version, srcManifest.version) > 0) {
        const spkiDer = Buffer.from(dm.key, 'base64');
        const extensionId = computeExtensionIdFromPublicKeyDer(spkiDer);
        return {
          ok: true,
          preservedNewer: true,
          extensionDir: destDir,
          crxPath,
          extensionId,
          version: String(dm.version),
        };
      }
    } catch (_) {}
  }

  let needsSync = force || !fsMod.existsSync(destManifestPath) || !fsMod.existsSync(crxPath);
  if (!needsSync) {
    try {
      const dm = JSON.parse(fsMod.readFileSync(destManifestPath, 'utf8'));
      if (compareSemver(dm.version, srcManifest.version) !== 0 || !dm.key) needsSync = true;
    } catch (_) {
      needsSync = true;
    }
  }

  if (needsSync) {
    fsMod.mkdirSync(destDir, { recursive: true });
    const files = collectExtensionFiles(sourceDir, '', fsMod);
    for (const f of files) {
      if (f.rel === 'manifest.json') continue;
      const targetFile = path.join(destDir, f.rel);
      fsMod.mkdirSync(path.dirname(targetFile), { recursive: true });
      fsMod.copyFileSync(f.abs, targetFile);
    }
  }

  const crxRes = buildCrx3Package({ sourceDir, outCrxPath: crxPath, keyPath, fsMod });
  fsMod.writeFileSync(destManifestPath, crxRes.patchedManifestBuffer);
  fsMod.writeFileSync(path.join(destDir, 'HOW_TO_INSTALL.txt'), buildHowToInstallText(destDir, crxRes.extensionId), 'utf8');

  return {
    ok: true,
    extensionDir: destDir,
    crxPath,
    extensionId: crxRes.extensionId,
    version: crxRes.version,
  };
}

const BROWSER_CATALOG = {
  chrome: {
    id: 'chrome',
    name: 'Google Chrome',
    isChromium: true,
    schemeUrl: 'chrome://extensions',
    darwinApps: ['/Applications/Google Chrome.app', 'Applications/Google Chrome.app'],
    darwinBinRel: 'Contents/MacOS/Google Chrome',
    winBins: ['Google\\Chrome\\Application\\chrome.exe'],
    linuxBins: ['google-chrome', 'google-chrome-stable'],
  },
  brave: {
    id: 'brave',
    name: 'Brave Browser',
    isChromium: true,
    schemeUrl: 'brave://extensions',
    darwinApps: ['/Applications/Brave Browser.app', 'Applications/Brave Browser.app'],
    darwinBinRel: 'Contents/MacOS/Brave Browser',
    winBins: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    linuxBins: ['brave-browser', 'brave'],
  },
  edge: {
    id: 'edge',
    name: 'Microsoft Edge',
    isChromium: true,
    schemeUrl: 'edge://extensions',
    darwinApps: ['/Applications/Microsoft Edge.app', 'Applications/Microsoft Edge.app'],
    darwinBinRel: 'Contents/MacOS/Microsoft Edge',
    winBins: ['Microsoft\\Edge\\Application\\msedge.exe'],
    linuxBins: ['microsoft-edge', 'microsoft-edge-stable'],
  },
  arc: {
    id: 'arc',
    name: 'Arc',
    isChromium: true,
    schemeUrl: 'arc://extensions',
    darwinApps: ['/Applications/Arc.app', 'Applications/Arc.app'],
    darwinBinRel: 'Contents/MacOS/Arc',
    winBins: ['Arc\\Arc.exe'],
    linuxBins: [],
  },
  vivaldi: {
    id: 'vivaldi',
    name: 'Vivaldi',
    isChromium: true,
    schemeUrl: 'vivaldi://extensions',
    darwinApps: ['/Applications/Vivaldi.app', 'Applications/Vivaldi.app'],
    darwinBinRel: 'Contents/MacOS/Vivaldi',
    winBins: ['Vivaldi\\Application\\vivaldi.exe'],
    linuxBins: ['vivaldi', 'vivaldi-stable'],
  },
  chromium: {
    id: 'chromium',
    name: 'Chromium',
    isChromium: true,
    schemeUrl: 'chrome://extensions',
    darwinApps: ['/Applications/Chromium.app', 'Applications/Chromium.app'],
    darwinBinRel: 'Contents/MacOS/Chromium',
    winBins: ['Chromium\\Application\\chrome.exe'],
    linuxBins: ['chromium', 'chromium-browser'],
  },
};

function findBrowserExecutable(meta, { platform = process.platform, homeDir = os.homedir(), env = process.env, fsMod = fs, execSyncImpl = execSync } = {}) {
  if (platform === 'darwin') {
    for (const rawApp of meta.darwinApps || []) {
      const appPath = path.isAbsolute(rawApp) ? rawApp : path.join(homeDir, rawApp);
      const bin = path.join(appPath, meta.darwinBinRel);
      if (fsMod.existsSync(bin)) return bin;
    }
    return '';
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, path.join(homeDir, 'AppData', 'Local')].filter(Boolean);
    for (const root of roots) {
      for (const rel of meta.winBins || []) {
        const candidate = path.join(root, rel);
        if (fsMod.existsSync(candidate)) return candidate;
      }
    }
    return '';
  }
  for (const binName of meta.linuxBins || []) {
    try {
      const p = String(execSyncImpl(`command -v ${binName} 2>/dev/null || true`, { encoding: 'utf8' }) || '').trim();
      if (p) return p.split('\n')[0].trim();
    } catch (_) {}
  }
  return '';
}

function detectDefaultBrowserId({ platform = process.platform, homeDir = os.homedir(), fsMod = fs, execSyncImpl = execSync } = {}) {
  try {
    if (platform === 'darwin') {
      const plist = path.join(homeDir, 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
      if (fsMod.existsSync(plist)) {
        const raw = execSyncImpl(`plutil -convert json -o - "${plist}"`, { encoding: 'utf8', timeout: 2000 });
        const parsed = JSON.parse(raw);
        const handlers = Array.isArray(parsed && parsed.LSHandlers) ? parsed.LSHandlers : [];
        const hit = handlers.find((h) => h && h.LSHandlerURLScheme === 'https') || handlers.find((h) => h && h.LSHandlerURLScheme === 'http');
        const bid = String((hit && (hit.LSHandlerRoleAll || hit.LSHandlerRoleViewer)) || '').toLowerCase();
        if (bid.includes('chrome') && !bid.includes('canary')) return { id: 'chrome', name: 'Google Chrome', isChromium: true, raw: bid };
        if (bid.includes('brave')) return { id: 'brave', name: 'Brave Browser', isChromium: true, raw: bid };
        if (bid.includes('edgemac') || bid.includes('edge')) return { id: 'edge', name: 'Microsoft Edge', isChromium: true, raw: bid };
        if (bid.includes('thebrowser') || bid.includes('arc')) return { id: 'arc', name: 'Arc', isChromium: true, raw: bid };
        if (bid.includes('vivaldi')) return { id: 'vivaldi', name: 'Vivaldi', isChromium: true, raw: bid };
        if (bid.includes('chromium')) return { id: 'chromium', name: 'Chromium', isChromium: true, raw: bid };
        if (bid.includes('safari')) return { id: 'safari', name: 'Safari', isChromium: false, raw: bid };
        if (bid.includes('firefox')) return { id: 'firefox', name: 'Firefox', isChromium: false, raw: bid };
      }
    } else if (platform === 'win32') {
      const out = String(execSyncImpl('reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId', { encoding: 'utf8', timeout: 2000 }) || '');
      if (/Chrome/i.test(out)) return { id: 'chrome', name: 'Google Chrome', isChromium: true, raw: out.trim() };
      if (/MSEdge/i.test(out)) return { id: 'edge', name: 'Microsoft Edge', isChromium: true, raw: out.trim() };
      if (/Brave/i.test(out)) return { id: 'brave', name: 'Brave Browser', isChromium: true, raw: out.trim() };
      if (/Vivaldi/i.test(out)) return { id: 'vivaldi', name: 'Vivaldi', isChromium: true, raw: out.trim() };
      if (/Firefox/i.test(out)) return { id: 'firefox', name: 'Firefox', isChromium: false, raw: out.trim() };
    } else {
      const out = String(execSyncImpl('xdg-settings get default-web-browser 2>/dev/null || true', { encoding: 'utf8', timeout: 2000 }) || '').trim().toLowerCase();
      if (out.includes('chrome')) return { id: 'chrome', name: 'Google Chrome', isChromium: true, raw: out };
      if (out.includes('brave')) return { id: 'brave', name: 'Brave Browser', isChromium: true, raw: out };
      if (out.includes('edge')) return { id: 'edge', name: 'Microsoft Edge', isChromium: true, raw: out };
      if (out.includes('vivaldi')) return { id: 'vivaldi', name: 'Vivaldi', isChromium: true, raw: out };
      if (out.includes('chromium')) return { id: 'chromium', name: 'Chromium', isChromium: true, raw: out };
      if (out.includes('firefox')) return { id: 'firefox', name: 'Firefox', isChromium: false, raw: out };
    }
  } catch (_) {}
  return { id: platform === 'darwin' ? 'safari' : (platform === 'win32' ? 'edge' : 'chrome'), name: platform === 'darwin' ? 'Safari' : (platform === 'win32' ? 'Microsoft Edge' : 'Chrome'), isChromium: platform !== 'darwin', raw: '' };
}

function detectBrowsers(opts = {}) {
  const platform = opts.platform || process.platform;
  const homeDir = opts.homeDir || os.homedir();
  const env = opts.env || process.env;
  const fsMod = opts.fsMod || fs;
  const execSyncImpl = opts.execSyncImpl || execSync;

  const installedBrowsers = [];
  for (const meta of Object.values(BROWSER_CATALOG)) {
    const exe = findBrowserExecutable(meta, { platform, homeDir, env, fsMod, execSyncImpl });
    if (exe) {
      installedBrowsers.push({ id: meta.id, name: meta.name, executablePath: exe, schemeUrl: meta.schemeUrl, isChromium: true });
    }
  }
  const defaultBrowser = detectDefaultBrowserId({ platform, homeDir, fsMod, execSyncImpl });
  const preferredChromiumBrowser = (defaultBrowser.isChromium && installedBrowsers.find((b) => b.id === defaultBrowser.id))
    || installedBrowsers[0]
    || null;

  return { defaultBrowser, installedBrowsers, preferredChromiumBrowser };
}

function externalExtensionDirsFor(platform, homeDir, browserId = '') {
  const dirs = [];
  const add = (id, name, dir) => {
    if (!browserId || browserId === id) dirs.push({ id, name, dir });
  };
  if (platform === 'darwin') {
    const appSup = path.join(homeDir, 'Library', 'Application Support');
    add('chrome', 'Google Chrome', path.join(appSup, 'Google', 'Chrome', 'External Extensions'));
    add('brave', 'Brave Browser', path.join(appSup, 'BraveSoftware', 'Brave-Browser', 'External Extensions'));
    add('edge', 'Microsoft Edge', path.join(appSup, 'Microsoft Edge', 'External Extensions'));
    add('vivaldi', 'Vivaldi', path.join(appSup, 'Vivaldi', 'External Extensions'));
    add('chromium', 'Chromium', path.join(appSup, 'Chromium', 'External Extensions'));
    add('arc', 'Arc', path.join(appSup, 'Arc', 'User Data', 'External Extensions'));
  } else if (platform === 'linux') {
    const cfg = path.join(homeDir, '.config');
    add('chrome', 'Google Chrome', path.join(cfg, 'google-chrome', 'External Extensions'));
    add('brave', 'Brave Browser', path.join(cfg, 'BraveSoftware', 'Brave-Browser', 'External Extensions'));
    add('edge', 'Microsoft Edge', path.join(cfg, 'microsoft-edge', 'External Extensions'));
    add('vivaldi', 'Vivaldi', path.join(cfg, 'vivaldi', 'External Extensions'));
    add('chromium', 'Chromium', path.join(cfg, 'chromium', 'External Extensions'));
  }
  return dirs;
}

const WIN_REG_BASES = [
  { id: 'chrome', name: 'Google Chrome', regBase: 'HKCU\\Software\\Google\\Chrome\\Extensions' },
  { id: 'brave', name: 'Brave Browser', regBase: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\Extensions' },
  { id: 'edge', name: 'Microsoft Edge', regBase: 'HKCU\\Software\\Microsoft\\Edge\\Extensions' },
];

function installExternalExtension(opts = {}) {
  const platform = opts.platform || process.platform;
  const homeDir = opts.homeDir || os.homedir();
  const env = opts.env || process.env;
  const fsMod = opts.fsMod || fs;
  const execSyncImpl = opts.execSyncImpl || execSync;
  const sync = syncStandaloneExtension(opts);
  if (!sync.ok) return sync;

  const browsers = detectBrowsers({ platform, homeDir, env, fsMod, execSyncImpl });
  const installedIds = new Set(browsers.installedBrowsers.map((b) => b.id));
  const payload = JSON.stringify({
    external_crx: sync.crxPath,
    external_version: sync.version,
  }, null, 2) + '\n';

  const registeredTargets = [];
  if (platform === 'darwin' || platform === 'linux') {
    const candidates = externalExtensionDirsFor(platform, homeDir, opts.browserId || '');
    for (const target of candidates) {
      // Register for installed browsers OR when explicitly requested (or testing all targets)
      const parentExists = fsMod.existsSync(path.dirname(target.dir));
      if (!opts.browserId && !opts.allTargets && !installedIds.has(target.id) && !parentExists) continue;
      try {
        fsMod.mkdirSync(target.dir, { recursive: true });
        const jsonPath = path.join(target.dir, `${sync.extensionId}.json`);
        fsMod.writeFileSync(jsonPath, payload, 'utf8');
        registeredTargets.push({ id: target.id, name: target.name, path: jsonPath });
      } catch (_) {}
    }
  } else if (platform === 'win32') {
    for (const target of WIN_REG_BASES) {
      if (opts.browserId && opts.browserId !== target.id) continue;
      const regKey = `${target.regBase}\\${sync.extensionId}`;
      try {
        execSyncImpl(`reg.exe add "${regKey}" /v path /t REG_SZ /d "${sync.crxPath}" /f`, { stdio: 'ignore' });
        execSyncImpl(`reg.exe add "${regKey}" /v version /t REG_SZ /d "${sync.version}" /f`, { stdio: 'ignore' });
        registeredTargets.push({ id: target.id, name: target.name, registryKey: regKey });
      } catch (_) {}
    }
  }

  return {
    ok: true,
    extensionId: sync.extensionId,
    version: sync.version,
    extensionDir: sync.extensionDir,
    crxPath: sync.crxPath,
    registeredTargets,
    defaultBrowser: browsers.defaultBrowser,
    preferredChromiumBrowser: browsers.preferredChromiumBrowser,
    installedBrowsers: browsers.installedBrowsers,
  };
}

function launchBrowserWithExtension(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const fsMod = opts.fsMod || fs;
  const inst = installExternalExtension(opts);
  if (!inst.ok) return inst;

  const target = (opts.browserId && (inst.installedBrowsers || []).find((b) => b.id === opts.browserId))
    || inst.preferredChromiumBrowser;
  if (!target || !target.executablePath) {
    return {
      ok: true,
      launched: false,
      extensionDir: inst.extensionDir,
      extensionId: inst.extensionId,
      message: 'No Chromium browser binary found — open the standalone extension folder manually.',
    };
  }

  const profileDir = path.join(homeDir, '.autobot', `browser-bot-profile-${target.id}`);
  try { fsMod.mkdirSync(profileDir, { recursive: true }); } catch (_) {}

  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${inst.extensionDir}`,
    '--no-first-run',
    target.schemeUrl || 'chrome://extensions',
  ];
  const child = spawn(target.executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return {
    ok: true,
    launched: true,
    browser: target,
    extensionDir: inst.extensionDir,
    extensionId: inst.extensionId,
    profileDir,
  };
}

module.exports = {
  EXTENSION_FOLDER_NAME,
  resolveStandaloneExtensionDir,
  getBundledSourceExtensionDir,
  loadOrCreateSigningKey,
  computeExtensionIdFromPublicKeyDer,
  buildCrx3Package,
  verifyCrx3Package,
  syncStandaloneExtension,
  detectBrowsers,
  installExternalExtension,
  launchBrowserWithExtension,
};
