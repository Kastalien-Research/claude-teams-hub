#!/usr/bin/env bash
# hub18 evaluator (instance 2): copy the evaluator tests into a worktree, run
# the requested predicate files with vitest, then remove exactly the files that
# were copied. Never commits anything. bash + coreutils only.
#   run-tests.sh <worktree> <predicate>...        e.g. run-tests.sh ../verifier-s0 f1 f2 h6
# Exit status: vitest's (0 = every requested file passed). If cleanup fails
# the script exits 3 regardless of the test outcome.
set -euo pipefail
WORKTREE="$(cd "$1" && pwd)"
shift
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$WORKTREE/src/celld/__tests__"
COPIED=()
for f in "$HERE"/tests/hub18-*.ts; do
  cp "$f" "$DEST/"
  COPIED+=("$DEST/$(basename "$f")")
done
FILES=()
for frag in "$@"; do
  for f in "$DEST"/hub18-"$frag"-*.test.ts; do FILES+=("src/celld/__tests__/$(basename "$f")"); done
done
STATUS=0
(cd "$WORKTREE" && pnpm exec vitest run "${FILES[@]}") || STATUS=$?
rm -f "${COPIED[@]}"
for f in "${COPIED[@]}"; do
  if [ -e "$f" ]; then echo "run-tests.sh: cleanup failed, $f still present" >&2; exit 3; fi
done
exit $STATUS
