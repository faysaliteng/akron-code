'use strict';
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

exports.default = async function afterPackHardenFuses(context) {
  const platform = context.electronPlatformName;
  const targetPath = resolveTargetBinary(context);
  console.log(`[harden-fuses] Flipping Electron Fuses on ${platform}: ${targetPath}`);

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
    console.log(`[harden-fuses] Re-signing macOS bundle ad-hoc for Apple Silicon AMFI: ${targetPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', targetPath], { stdio: 'inherit' });
  }
  console.log('[harden-fuses] Completed.');
};
