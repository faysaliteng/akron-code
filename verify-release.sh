#!/bin/bash
# Verify shipped macOS build contains Phases 1-5, hardened Electron Fuses, valid codesign, and SHA256 sums.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
R="$ROOT/release"
APP="$R/mac-arm64/Akron Code.app"
if [ ! -d "$APP" ] && [ -d "$R/mac/Akron Code.app" ]; then
  APP="$R/mac/Akron Code.app"
fi
ASAR="$APP/Contents/Resources/app.asar"
X=$(mktemp -d)
trap 'rm -rf "$X"' EXIT

echo "=== release dir ==="
ls -la "$R" | sed -n '1,25p'

echo
echo "=== asar present? ==="
ls -la "$ASAR"

npx --yes @electron/asar extract "$ASAR" "$X" >/dev/null

echo
echo "=== main-process markers (Phases 1-5) ==="
check() {
  local label="$1" pat="$2" files="$3"
  if grep -rlq -- "$pat" $files 2>/dev/null; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s\n' "$label"
    exit 1
  fi
}
check "browser inspect mode"            'setInspectMode'          "$X/electron/browser.js"
check "execution environments"          'openSshShell'            "$X/electron/environments.js"
check "dependency manager"              'getDependenciesStatus'   "$X/electron/dep-manager.js"
check "auto-updater"                    'checkForUpdate'          "$X/electron/updater.js"
check "IDE layout persistence"          'loadLayout'              "$X/electron/ide/layout-store.js"
check "context spill-to-disk"           'maybeSpillOutput'        "$X/electron/spill.js"
check "context output masking"          'maskOlderToolOutputs'    "$X/electron/context-pipeline.js"
check "doom-loop guard"                 'createLoopGuard'         "$X/electron/loop-guard.js"
check "atomic ApplyPatch"               'applyPatchToWorkspace'   "$X/electron/apply-patch.js"
check "stale-read edit guard"           'checkStaleRead'          "$X/electron/ide/edit-guard.js"
check "codebase hybrid index"           'searchCodebase'          "$X/electron/ide/codebase-index.js"
check "isolated RunToolScript"          'runToolScript'           "$X/electron/codemode.js"
check "SQLite session DB"               'initSessionDb'           "$X/electron/session-db.js"
check "skill learner"                   'extractSkillToDisk'      "$X/electron/skill-learner.js"
check "OS sandbox profiles"             'canonicalizeShellCommand' "$X/electron/os-sandbox.js"
check "cross-OS notifications"          'createNotificationService' "$X/electron/notifications.js"
check "brand seal guard"                'verifyBrandIntegrity'    "$X/electron/brand-guard.js"
check "brand seal manifest"             'sealDigest'              "$X/electron/brand-seal.json"
check "LICENSE & TRADEMARKS bundled"    'AkronLogic'              "$X/LICENSE.md"
check "TRADEMARKS bundled"              'Akron Browser Bot'       "$X/TRADEMARKS.md"

echo
echo "=== source maps hygiene ==="
MAP_COUNT=$(find "$X" -name '*.map' | wc -l | tr -d ' ')
echo "  .map files inside ASAR: $MAP_COUNT"
[ "$MAP_COUNT" -eq 0 ]

echo
echo "=== renderer bundle markers ==="
JS=$(ls -S "$X"/dist/assets/index-*.js 2>/dev/null | head -1)
echo "  bundle: $(basename "$JS") ($(wc -c < "$JS" | tr -d ' ') bytes)"
for m in 'ide-status-bar' 'ide-changes-panel' 'env-picker-btn' 'browser-inspect-banner' 'akron-mindmap-view' 'akronlogic.com'; do
  if grep -qF -- "$m" "$JS"; then printf '  ok   %s\n' "$m"; else printf '  FAIL %s\n' "$m"; exit 1; fi
done

echo
echo "=== bundled resources & unpacked wasm/icons ==="
ls -d "$APP/Contents/Resources"/* 2>/dev/null | sed 's|.*/Resources/|  resource: |'
for req in \
  "$APP/Contents/Resources/icon.png" \
  "$APP/Contents/Resources/icon.ico" \
  "$APP/Contents/Resources/app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm"; do
  if [ -f "$req" ]; then
    printf '  ok   unpacked: %s\n' "${req#$APP/Contents/Resources/}"
  else
    printf '  FAIL missing unpacked file: %s\n' "$req"
    exit 1
  fi
done

echo
echo "=== electron fuses verification ==="
APP="$APP" node -e "
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
(async () => {
  const wire = await getCurrentFuseWire(process.env.APP);
  const checkFuse = (name, opt, expected) => {
    const raw = wire[opt];
    const val = raw === 49 ? 1 : (raw === 48 ? 0 : raw);
    console.log('  fuse', name, '->', val, '(expected', expected + ')');
    if (val !== expected) process.exit(1);
  };
  checkFuse('RunAsNode', FuseV1Options.RunAsNode, 0);
  checkFuse('EnableCookieEncryption', FuseV1Options.EnableCookieEncryption, 1);
  checkFuse('EnableNodeOptionsEnvironmentVariable', FuseV1Options.EnableNodeOptionsEnvironmentVariable, 0);
  checkFuse('EnableNodeCliInspectArguments', FuseV1Options.EnableNodeCliInspectArguments, 0);
  checkFuse('EnableEmbeddedAsarIntegrityValidation', FuseV1Options.EnableEmbeddedAsarIntegrityValidation, 1);
  checkFuse('OnlyLoadAppFromAsar', FuseV1Options.OnlyLoadAppFromAsar, 1);
})();
"

echo
echo "=== codesign verification ==="
codesign --verify --deep --strict "$APP" && echo "  codesign OK"

echo
echo "=== info.plist version ==="
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP/Contents/Info.plist"

echo
echo "=== refresh SHA256SUMS.txt ==="
cd "$R"
FILES=$(ls -1 AkronCode-* 2>/dev/null | grep -v blockmap || true)
if [ -n "$FILES" ]; then
  shasum -a 256 $FILES > SHA256SUMS.txt
  cat SHA256SUMS.txt
fi
echo
echo "VERIFY_RELEASE_DONE"
