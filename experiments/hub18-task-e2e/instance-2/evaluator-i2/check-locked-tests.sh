#!/usr/bin/env bash
# hub18 H5: every locked test file in <worktree> is byte-identical to S0.
#   check-locked-tests.sh <worktree>
# bash + coreutils (shasum) only.
set -euo pipefail
WORKTREE="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
COUNT="$(wc -l < "$HERE/locked-tests.sha256" | tr -d ' ')"
if (cd "$WORKTREE" && shasum -a 256 --check --quiet "$HERE/locked-tests.sha256"); then
  echo "H5 PASS: $COUNT locked files byte-identical to S0"
else
  echo "H5 FAIL: locked test file(s) differ from S0 (see above)"
  exit 1
fi
