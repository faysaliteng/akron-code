'use strict';
/**
 * Build native C++20 Windows ARM64 desktop app (`AkronCode.exe`) +
 * self-extracting native C++20 Windows installer (`AkronCode-Setup.exe`).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SDK = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc/scratch/win-sdk';
const ZIG = path.join(SDK, 'zig/zig');
const NODE_WIN = path.join(SDK, 'node-win-arm64/node.exe');
const WV2_INC = path.join(SDK, 'webview2/build/native/include');
const WV2_DLL = path.join(SDK, 'webview2/build/native/arm64/WebView2Loader.dll');

const OUT_DIR = path.join(REPO, 'release-win');
const STAGE = path.join(OUT_DIR, 'stage');
const TARGET = 'aarch64-windows-gnu';

function assertExists(p, label) {
  if (!fs.existsSync(p)) throw new Error(`Missing ${label}: ${p}`);
}

// Build a standard Windows .res binary containing RT_MANIFEST (asInvoker + ComCtl v6)
// and RT_ICON / RT_GROUP_ICON parsed directly from build/icon.ico. LLD links .res natively!
function buildWin32Res(icoPath, resOutPath, description = 'Akron Code') {
  const blocks = [];
  const align4 = (n) => (n + 3) & ~3;
  const emptyHdr = Buffer.from([
    0x00,0x00,0x00,0x00, 0x20,0x00,0x00,0x00, 0xff,0xff,0x00,0x00, 0xff,0xff,0x00,0x00,
    0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
  ]);
  blocks.push(emptyHdr);

  function addResEntry(typeId, nameId, dataBuf, lang = 0x0409) {
    // NUMERIC type + NUMERIC name header is fixed 32 bytes (20 bytes + 12 trailing fields)
    const hdr = Buffer.alloc(32, 0);
    hdr.writeUInt32LE(dataBuf.length, 0);
    hdr.writeUInt32LE(32, 4);
    hdr.writeUInt16LE(0xffff, 8);
    hdr.writeUInt16LE(typeId, 10);
    hdr.writeUInt16LE(0xffff, 12);
    hdr.writeUInt16LE(nameId, 14);
    hdr.writeUInt16LE(0x1030, 22); // MEMORYFLAGS
    hdr.writeUInt16LE(lang, 24);
    const padLen = align4(dataBuf.length) - dataBuf.length;
    blocks.push(hdr, dataBuf, padLen ? Buffer.alloc(padLen, 0) : Buffer.alloc(0));
  }

  // 1. RT_MANIFEST = 24, ID = 1 (prevents Windows Installer Detection UAC + enables Win11 visual styles)
  const manifestXml = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\r\n` +
    `  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="AkronLogic.AkronCode" type="win32"/>\r\n` +
    `  <description>${description}</description>\r\n` +
    `  <dependency><dependentAssembly>\r\n` +
    `    <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>\r\n` +
    `  </dependentAssembly></dependency>\r\n` +
    `  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">\r\n` +
    `    <security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security>\r\n` +
    `  </trustInfo>\r\n` +
    `  <application xmlns="urn:schemas-microsoft-com:asm.v3">\r\n` +
    `    <windowsSettings><dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness></windowsSettings>\r\n` +
    `  </application>\r\n` +
    `</assembly>\r\n`,
    'utf8'
  );
  addResEntry(24, 1, manifestXml);

  // 2. Parse build/icon.ico -> RT_ICON (3) + RT_GROUP_ICON (14, ID=101)
  if (fs.existsSync(icoPath)) {
    const ico = fs.readFileSync(icoPath);
    const count = ico.readUInt16LE(4);
    const grp = Buffer.alloc(6 + count * 14);
    grp.writeUInt16LE(0, 0);
    grp.writeUInt16LE(ico.readUInt16LE(2), 2);
    grp.writeUInt16LE(count, 4);
    for (let i = 0; i < count; i++) {
      const dirOff = 6 + i * 16;
      const bytesInRes = ico.readUInt32LE(dirOff + 8);
      const imgOff = ico.readUInt32LE(dirOff + 12);
      const imgSlice = ico.subarray(imgOff, imgOff + bytesInRes);
      const iconId = i + 1;
      addResEntry(3, iconId, imgSlice);
      ico.copy(grp, 6 + i * 14, dirOff, dirOff + 12);
      grp.writeUInt16LE(iconId, 6 + i * 14 + 12);
    }
    addResEntry(14, 101, grp);
  }

  fs.mkdirSync(path.dirname(resOutPath), { recursive: true });
  fs.writeFileSync(resOutPath, Buffer.concat(blocks));
}

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function main() {
  assertExists(ZIG, 'Zig toolchain');
  assertExists(NODE_WIN, 'Windows ARM64 Node.js runtime');
  assertExists(path.join(WV2_INC, 'WebView2.h'), 'WebView2.h');
  assertExists(WV2_DLL, 'WebView2Loader.dll');
  assertExists(path.join(REPO, 'dist/index.html'), 'Built dist/ UI bundle (run npm run build first)');

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(path.join(STAGE, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(STAGE, 'app', 'node_modules'), { recursive: true });

  const resFile = path.join(OUT_DIR, 'akron.res');
  buildWin32Res(path.join(REPO, 'build/icon.ico'), resFile, 'Akron Code by Akronlogic.com');

  // 1. Compile Native C++20 Win32 + WebView2 main executable (`AkronCode.exe`)
  const mainExe = path.join(STAGE, 'AkronCode.exe');
  run(ZIG, [
    'c++', '-target', TARGET, '-std=c++20', '-O2', '-s',
    '-municode', '-Wl,--subsystem,windows', '-fms-extensions',
    '-I', path.join(REPO, 'native-win32/include'),
    '-I', WV2_INC,
    path.join(REPO, 'native-win32/src/main.cpp'),
    resFile,
    '-o', mainExe,
    '-lole32', '-loleaut32', '-luuid', '-lshlwapi', '-lshell32', '-ldwmapi', '-luser32', '-lgdi32', '-ladvapi32',
  ]);

  // 2. Compile Native C++20 Uninstaller (`AkronCode-Uninstall.exe`)
  const uninstExe = path.join(STAGE, 'AkronCode-Uninstall.exe');
  run(ZIG, [
    'c++', '-target', TARGET, '-std=c++20', '-O2', '-s',
    '-municode', '-Wl,--subsystem,windows',
    path.join(REPO, 'native-win32/src/uninstaller.cpp'),
    resFile,
    '-o', uninstExe,
    '-lole32', '-lshell32', '-lshlwapi', '-luser32', '-ladvapi32',
  ]);

  // 3. Compile Native C++20 Installer stub (`AkronCode-Setup-base.exe`)
  const setupBase = path.join(OUT_DIR, 'AkronCode-Setup-base.exe');
  run(ZIG, [
    'c++', '-target', TARGET, '-std=c++20', '-O2', '-s',
    '-municode', '-Wl,--subsystem,windows',
    path.join(REPO, 'native-win32/src/installer.cpp'),
    resFile,
    '-o', setupBase,
    '-lole32', '-lshell32', '-lshlwapi', '-ldwmapi', '-lcomctl32', '-luser32', '-lgdi32', '-ladvapi32',
  ]);

  // 5. Populate payload staging directory
  fs.copyFileSync(WV2_DLL, path.join(STAGE, 'WebView2Loader.dll'));
  fs.copyFileSync(path.join(REPO, 'build/icon.ico'), path.join(STAGE, 'akron.ico'));
  fs.copyFileSync(NODE_WIN, path.join(STAGE, 'runtime/node.exe'));

  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(STAGE, 'app/package.json'));
  fs.cpSync(path.join(REPO, 'dist'), path.join(STAGE, 'app/dist'), { recursive: true });
  fs.cpSync(path.join(REPO, 'electron'), path.join(STAGE, 'app/electron'), { recursive: true });
  if (fs.existsSync(path.join(REPO, 'resources'))) {
    fs.cpSync(path.join(REPO, 'resources'), path.join(STAGE, 'app/resources'), { recursive: true });
  }
  if (fs.existsSync(path.join(REPO, 'node_modules/ws'))) {
    fs.cpSync(path.join(REPO, 'node_modules/ws'), path.join(STAGE, 'app/node_modules/ws'), { recursive: true });
  }

  // Also compile x86_64 Windows C++20 binary (`AkronCode-x64.exe`) and copy standalone EXEs
  const x64Exe = path.join(OUT_DIR, 'AkronCode-x64.exe');
  run(ZIG, [
    'c++', '-target', 'x86_64-windows-gnu', '-std=c++20', '-O2', '-s',
    '-municode', '-Wl,--subsystem,windows', '-fms-extensions',
    '-I', path.join(REPO, 'native-win32/include'),
    '-I', WV2_INC,
    path.join(REPO, 'native-win32/src/main.cpp'),
    '-o', x64Exe,
    '-lole32', '-loleaut32', '-luuid', '-lshlwapi', '-lshell32', '-ldwmapi', '-luser32', '-lgdi32', '-ladvapi32',
  ]);
  fs.copyFileSync(mainExe, path.join(OUT_DIR, 'AkronCode.exe'));

  // 6. Pack stage/ into tar.gz and append self-extracting trailer onto AkronCode-Setup.exe
  const payloadTgz = path.join(OUT_DIR, 'payload.tar.gz');
  run('tar', ['-czf', payloadTgz, '-C', STAGE, '.']);

  const baseBuf = fs.readFileSync(setupBase);
  const pkgBuf = fs.readFileSync(payloadTgz);
  const trailer = Buffer.alloc(16);
  trailer.writeBigUInt64LE(BigInt(baseBuf.length), 0);
  trailer.write('AKRNEND1', 8, 'ascii');

  const finalSetup = path.join(OUT_DIR, 'AkronCode-Setup.exe');
  fs.writeFileSync(finalSetup, Buffer.concat([baseBuf, pkgBuf, trailer]));
  fs.rmSync(setupBase, { force: true });
  fs.rmSync(payloadTgz, { force: true });

  console.log('\nWIN32_NATIVE_BUILD_OK:');
  console.log('  Standalone EXE:', mainExe, `(${(fs.statSync(mainExe).size / 1024).toFixed(1)} KB)`);
  console.log('  Setup Installer:', finalSetup, `(${(fs.statSync(finalSetup).size / (1024 * 1024)).toFixed(1)} MB)`);
}

main();
