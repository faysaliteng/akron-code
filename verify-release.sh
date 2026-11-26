#!/bin/bash
# Verify the shipped DMG actually contains this round's code, then refresh the sums.
set -u
A="/Users/saimon/Documents/Default Project/autobot"
R="$A/release"
T="/private/var/folders/74/jftc3_v96yn6y2dsbhp5s1k40000gn/T/opencode"
APP="$R/mac-arm64/Akron Bot.app"
ASAR="$APP/Contents/Resources/app.asar"
X="$T/asar-verify"

echo "=== release dir ==="
ls -la "$R" | sed -n '1,20p'
echo
echo "=== asar present? ==="
ls -la "$ASAR" 2>/dev/null || { echo "MISSING $ASAR"; exit 1; }

rm -rf "$X"; mkdir -p "$X"
npx --yes @electron/asar extract "$ASAR" "$X" >/dev/null 2>&1 || { echo "asar extract failed"; exit 1; }

echo
echo "=== main-process markers (electron/) ==="
check() {
  local label="$1" pat="$2" files="$3"
  if grep -rlq -- "$pat" $files 2>/dev/null; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s\n' "$label"
  fi
}
check "404 names the endpoint (err.endpoint)" 'err.endpoint' "$X/electron/*.js"
check "404 banner suffix (asked host/path)"   "asked ' + u.host" "$X/electron/*.js"
check "fixed redirect port (chatgpt)"        'fixedRedirectPort' "$X/electron/*.js"
check "sign-in cancel IPC"                   'providerSignInCancel' "$X/electron/*.js"
check "live context window (max_input_tokens)" 'max_input_tokens' "$X/electron/*.js"
check "reconnect code normaliser"            'normalizeReconnectCode' "$X/electron/*.js"
check "swarm admits oauth roster"            'isFrontier' "$X/electron/*.js"
check "claude ownership lock"                'withClaudeLock' "$X/electron/*.js"
check "orchestrator pool validator (module)"  'pruneUnserved' "$X/electron/orch-pool.js"
check "orchestrator pool wired per turn"      'validateOrchestrator' "$X/electron/main.js"
check "orchestrator drop notice text"          "' orchestrator '" "$X/electron/main.js"
check "orchestrator pool hydration (module)"   'hydrateOrchestrator' "$X/electron/orch-hydrate.js"
check "pool hydration wired per turn"          'hydrateOrchestrator(orchSource, hydrateProvider)' "$X/electron/main.js"
check "scheduled runs mint a token too"        'hydrateOrchestrator(orch, hydrateProvider)' "$X/electron/main.js"
check "dead pool row notice"                   'needs to be signed in again' "$X/electron/orch-hydrate.js"
check "reqdump auth fingerprint"               'sha12' "$X/electron/providertransport.js"
check "claude 5-hour allowance hint"           'claudeAllowanceHint' "$X/electron/*.js"
check "gemini schema lowering (params)"        'toGeminiSchema'      "$X/electron/providertransport.js"
check "gemini schema lowering (tools)"         'toGeminiDeclarations' "$X/electron/providertransport.js"
check "429 credit wall named as credits"       'creditWall'          "$X/electron/llm.js"
check "credit wall not retried"                'usage credits'       "$X/electron/providertransport.js"

echo
echo "=== renderer markers (dist assets) ==="
JS=$(ls -S "$X"/dist/assets/index-*.js 2>/dev/null | head -1)
if [ -n "$JS" ]; then
  echo "  bundle: $(basename "$JS") ($(wc -c < "$JS" | tr -d ' ') bytes)"
  for m in 'orch-pool' 'orch-check' 'Filter models' 'prov-notice-x' 'ctx-toast' 'ctx-toast-title' providerSignInCancel browser-tabs-actions composer-topbar 'noticebar-x'; do
    if grep -qF -- "$m" "$JS"; then printf '  ok   %s\n' "$m"; else printf '  FAIL %s\n' "$m"; fi
  done
  # CSS: composer overflow + notice border
  CSS=$(ls "$X"/dist/assets/index-*.css 2>/dev/null | head -1)
  [ -n "$CSS" ] && { echo "  css: $(basename "$CSS")"; for m in 'composer-topbar' 'prov-notice.warn' 'ctx-toast' 'noticebar-x'; do if grep -qF -- "$m" "$CSS"; then printf '  ok   .%s css\n' "$m"; else printf '  FAIL .%s css\n' "$m"; fi; done; }
else
  echo "  FAIL no dist/assets/index-*.js in asar"
fi

echo
echo "=== bundled runtimes ==="
for r in claude-code codex grok; do
  d=$(find "$X" -type d -name "$r" 2>/dev/null | head -1)
  if [ -n "$d" ]; then echo "  ok   $r -> $(find "$d" -maxdepth 2 -type f -name '*.js' -o -maxdepth 2 -type f -perm +111 | head -1 | xargs basename 2>/dev/null)"; else echo "  --   $r not in asar (may live in extraResources)"; fi
done
ls -d "$APP/Contents/Resources"/runtimes/* 2>/dev/null | sed 's|.*/Resources/|  extraResources: |' | head

echo
echo "=== info.plist version ==="
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null
/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP/Contents/Info.plist" 2>/dev/null

echo
echo "=== refresh SHA256SUMS ==="
cd "$R" || exit 1
shasum -a 256 AkronBot-1.0.0-arm64.dmg AkronBot-1.0.0-arm64.zip > SHA256SUMS.txt
cat SHA256SUMS.txt
echo
echo "DONE"
