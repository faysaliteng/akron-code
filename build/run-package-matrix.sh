#!/bin/bash
# Run the full packaged-app proof matrix against a live CDP port.
# Usage: build/run-package-matrix.sh [port] [logdir]
# Every probe exits non-zero on failure, so the exit code of each is the verdict.
set -u
PORT="${1:-9444}"
LOGDIR="${2:-$(mktemp -d)}"
cd "$(dirname "$0")/.." || exit 1
mkdir -p "$LOGDIR"

PROBES="probe-packaged probe-ui probe-picker probe-logo probe-capability probe-build-app probe-orch-prune probe-notices-toast probe-noticebar"
fails=0
for p in $PROBES; do
  log="$LOGDIR/$p.log"
  node "build/$p.cjs" "$PORT" >"$log" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then printf '  ok   %-20s exit 0\n' "$p"
  else printf '  FAIL %-20s exit %s  (see %s)\n' "$p" "$rc" "$log"; fails=$((fails+1)); fi
done

echo
echo "=== matrix: $fails failing of $(echo $PROBES | wc -w | tr -d ' ') ==="
echo "logs: $LOGDIR"
exit $([ $fails -eq 0 ] && echo 0 || echo 1)
