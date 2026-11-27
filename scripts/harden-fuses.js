'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

function resolveTargetBinary(context) {
  const platform = context.electronPlatformName;
  const appOutDir = context.appOutDir;
  const productFilename = context.packager.appInfo.productFilename;
  if (platform === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`);
  }
  if (platform === 'win32') {
    return path.join(appOutDir, `${productFilename}.exe`);
  }
  const exeName = context.packager.executableName || productFilename || 'akronbot';
  return path.join(appOutDir, exeName);
}

function normalizeWinAsarIntegrityPath(exePath) {
  let resedit = null;
  try {
    resedit = require('resedit');
  } catch (_) {
    return;
  }
  const buf = fs.readFileSync(exePath);
  const exe = resedit.NtExecutable.from(buf);
  const res = resedit.NtExecutableResource.from(exe);
  let changed = false;
  for (const entry of res.entries) {
    if (entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR') {
      const list = JSON.parse(Buffer.from(entry.bin).toString('utf8'));
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.file === 'string' && item.file.includes('/')) {
            item.file = item.file.replace(/\//g, '\\');
            changed = true;
          }
        }
        if (changed) {
          entry.bin = Buffer.from(JSON.stringify(list));
        }
      }
    }
  }
  if (changed) {
    res.outputResource(exe);
    fs.writeFileSync(exePath, Buffer.from(exe.generate()));
    console.log(`[harden-fuses] Normalized ELECTRONASAR PE path separators in ${exePath}`);
  }
}

function ensureUnpackedIcons(context) {
  const platform = context.electronPlatformName;
  const targetPath = resolveTargetBinary(context);
  const resDir = platform === 'darwin'
    ? path.join(targetPath, 'Contents', 'Resources')
    : path.join(path.dirname(targetPath), 'resources');
  if (!fs.existsSync(resDir)) return;
  const projectRoot = path.resolve(__dirname, '..');
  for (const name of ['icon.png', 'icon.ico']) {
    const src = path.join(projectRoot, 'build', name);
    const dest = path.join(resDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
}

exports.default = async function afterPackHardenFuses(context) {
  const platform = context.electronPlatformName;
  const targetPath = resolveTargetBinary(context);
  ensureUnpackedIcons(context);
  console.log(`[harden-fuses] Flipping Electron Fuses on ${platform}: ${targetPath}`);

  if (platform === 'win32') {
    normalizeWinAsarIntegrityPath(targetPath);
  }

  await flipFuses(targetPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin' || platform === 'win32',
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  if (platform === 'darwin') {
    // A stable signing identity keeps the macOS TCC grants (Screen Recording,
    // Accessibility) valid across rebuilds; ad-hoc signatures change their
    // code hash every build, so macOS silently drops the grants each time.
    const ident = process.env.AKRON_SIGN_IDENTITY || 'Akron Code Local Signing';
    let haveIdent = false;
    try {
      haveIdent = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' }).includes(`"${ident}"`);
    } catch (_) { haveIdent = false; }
    const signAs = haveIdent ? ident : '-';
    const entPath = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist');
    console.log(`[harden-fuses] Re-signing macOS bundle (${haveIdent ? ident : 'ad-hoc'}): ${targetPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', signAs, targetPath], { stdio: 'inherit' });
    if (fs.existsSync(entPath)) {
      const fwDir = path.join(targetPath, 'Contents', 'Frameworks');
      if (fs.existsSync(fwDir)) {
        for (const entry of fs.readdirSync(fwDir)) {
          if (entry.endsWith('.app')) {
            execFileSync('codesign', ['--force', '--sign', signAs, '--entitlements', entPath, path.join(fwDir, entry)], { stdio: 'inherit' });
          }
        }
      }
      execFileSync('codesign', ['--force', '--sign', signAs, '--entitlements', entPath, targetPath], { stdio: 'inherit' });
    }
  }
  console.log('[harden-fuses] Completed.');
};
