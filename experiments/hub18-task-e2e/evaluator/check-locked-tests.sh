#!/usr/bin/env bash
# hub18 H5: every locked test file in <worktree> is byte-identical to S0.
#   check-locked-tests.sh <worktree>
set -u
WORKTREE="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
( cd "$WORKTREE" && shasum -a 256 --check --quiet "$HERE/locked-tests.sha256" )
STATUS=$?
if [ $STATUS -eq 0 ]; then echo "H5 PASS: $(wc -l < "$HERE/locked-tests.sha256" | tr -d ' ') locked files byte-identical to S0"; else echo "H5 FAIL: locked test file(s) differ from S0 (see above)"; fi
exit $STATUS
