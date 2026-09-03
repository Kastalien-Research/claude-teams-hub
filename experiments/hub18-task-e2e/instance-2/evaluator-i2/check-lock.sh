#!/usr/bin/env bash
# hub18 lock check (instance 2): recompute the manifest and compare its sha256
# with LOCK.sha256. Exit 0 = lock intact; 1 = mismatch (diff against the
# recorded lock-manifest.txt is printed); 2 = no lock yet.
#   check-lock.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/LOCK.sha256" ] || { echo "LOCK MISSING: $HERE/LOCK.sha256"; exit 2; }
EXPECTED="$(tr -d ' \n' < "$HERE/LOCK.sha256")"
ACTUAL="$("$HERE/make-manifest.sh" | shasum -a 256 | cut -d' ' -f1)"
if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "LOCK OK $ACTUAL"
else
  echo "LOCK MISMATCH expected $EXPECTED actual $ACTUAL"
  "$HERE/make-manifest.sh" | diff "$HERE/lock-manifest.txt" - || true
  exit 1
fi
