#!/usr/bin/env bash
# hub18 evaluator: copy the evaluator tests into a worktree, run the requested
# files with vitest, then remove them again. Never commits anything.
#   run-tests.sh <worktree> <test-name-fragment>...
# Example: run-tests.sh ../verifier-s0 f1 f2 f3
set -u
WORKTREE="$1"
shift
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$WORKTREE/src/celld/__tests__"
cp "$HERE"/tests/hub18-*.ts "$DEST"/
FILES=()
for frag in "$@"; do
  for f in "$DEST"/hub18-*"$frag"*.test.ts; do FILES+=("src/celld/__tests__/$(basename "$f")"); done
done
(cd "$WORKTREE" && pnpm exec vitest run "${FILES[@]}")
STATUS=$?
trash "$DEST"/hub18-*.ts
exit $STATUS
